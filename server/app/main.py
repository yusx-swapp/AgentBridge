"""AgentBridge server — FastAPI app: auth, management REST, runtime REST, and two
WebSocket endpoints (human terminal + devbox connector)."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import mimetypes
import os
import re
import secrets
import asyncio
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import (
    FastAPI, Request, Response, HTTPException, Depends, WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session as OrmSession, object_session

from . import models
from .models import (
    User, Devbox, DevboxProject, Token, Agent, Session, Message, BootstrapState,
    Invitation, Organization, Workspace, Membership, WorkspaceInvitation,
    SessionParticipant,
    PROTOCOL_VERSION, ROLE_OWNER, ROLE_MEMBER, now,
    WS_ROLE_OWNER, WS_ROLE_ADMIN, WS_ROLE_OPERATOR, WS_ROLE_VIEWER,
    VALID_WS_ROLES,
)
from .util import (
    new_id, new_token, hash_token, hash_password, verify_password_ex,
)
from .hub import hub, DevboxConn, HumanConn
from .config import settings
from .live import live_registry
from .recording import RecordingStore, NEW, DUPLICATE, GAP, CONFLICT, output_ack_response
from .logging import configure_logging, log_event
from .capacity import collect_capacity, transition_event
from .audit import audit_event
from .collaboration import (
    LeaseConflict, LeaseError, PermissionDenied, acquire_keyboard_lease, can_control,
    get_keyboard_lease, get_role, handoff_keyboard_lease, lease_is_expired,
    list_user_workspaces, release_keyboard_lease, renew_keyboard_lease,
    require_workspace_access,
)
from .security import (
    SAFE_METHODS, RateLimiter, RateLimitRule, build_security_headers,
    is_origin_allowed,
)
from .identity import (
    MicrosoftPrincipal, build_microsoft_principal, normalize_email,
    normalize_username_hint,
)
from agentbridge.product import DISPLAY_NAME, NAME, env
from .integrations import InputRejected, runtime_policy

from . import version as version_info

import logging as _logging

configure_logging(env("LOG_LEVEL", "INFO"))
logger = _logging.getLogger(NAME)
_capacity_status = "ok"
_api_limiter = RateLimiter(RateLimitRule(settings.rate_limit_api_per_minute, 60))
_login_limiter = RateLimiter(RateLimitRule(settings.rate_limit_login_per_minute, 60))
_token_limiter = RateLimiter(RateLimitRule(settings.rate_limit_token_per_minute, 60))
_RATE_EXEMPT = {"/api/health", "/api/ready", "/api/version", "/api/auth/bootstrap-status"}
_LOGIN_RATE_PATHS = {
    "/api/auth/login", "/api/auth/microsoft/start", "/api/auth/microsoft/callback",
}


def _durable_events_loader(session_id: str):
    """Load committed v3 frames for a session using a short-lived DB session.

    Used by the LiveRegistry so it never retains a request-scoped Session.
    """
    db = models.SessionLocal()
    try:
        return RecordingStore.durable_events(db, session_id)
    finally:
        db.close()


live_registry.durable_loader = _durable_events_loader
recording_store = RecordingStore()


def observe_capacity(report, *, source: str) -> None:
    """Log only capacity transitions, avoiding one warning per health probe."""

    global _capacity_status
    event = transition_event(_capacity_status, report.status)
    _capacity_status = report.status
    if event is None:
        return
    log_event(
        logger,
        event,
        level=_logging.INFO if report.status == "ok" else _logging.WARNING,
        status=report.status,
        resources=[r.name for r in report.resources if r.status != "ok"],
        source=source,
    )


signer = URLSafeTimedSerializer(settings.secret, salt="deepbox-session")

app = FastAPI(title=DISPLAY_NAME)

@app.middleware("http")
async def security_baseline(request: Request, call_next):
    """Production request guards plus baseline headers on every response."""
    path = request.url.path
    client = request.client.host if request.client else "unknown"
    if settings.rate_limit_enabled and path.startswith("/api/") and path not in _RATE_EXEMPT:
        if path in _LOGIN_RATE_PATHS:
            limiter, path_class = _login_limiter, "login"
        elif "/tokens" in path or path.endswith("/devboxes"):
            limiter, path_class = _token_limiter, "credentials"
        else:
            limiter, path_class = _api_limiter, "api"
        decision = limiter.check((client, path_class))
        if not decision.allowed:
            audit_event("http.rate_limited", outcome="denied", request=request,
                        resource_type="route", resource_id=path,
                        details={"retry_after": decision.retry_after})
            response = JSONResponse({"detail": "rate limit exceeded"}, status_code=429,
                                    headers={"Retry-After": str(decision.retry_after)})
            response.headers.update(build_security_headers(production=settings.production))
            return response
    # Browser mutation requests authenticated by ambient cookies must prove
    # same-site intent. Bearer connector requests are not cookie-authenticated.
    if (settings.production and request.method.upper() not in SAFE_METHODS
            and request.cookies.get("deepbox_session")
            and not request.headers.get("authorization", "").lower().startswith("bearer ")
            and not is_origin_allowed(request.method, request.headers.get("origin"),
                                      settings.allowed_origins)):
        audit_event("http.csrf_rejected", outcome="denied", request=request,
                    resource_type="route", resource_id=path)
        response = JSONResponse({"detail": "origin not allowed"}, status_code=403)
        response.headers.update(build_security_headers(production=True))
        return response
    response = await call_next(request)
    response.headers.update(build_security_headers(production=settings.production))
    if path.startswith("/api/auth/") or "/tokens" in path:
        response.headers["Cache-Control"] = "no-store"
    elif path == "/" or path.startswith("/static/"):
        # The shell and its dynamically loaded helpers must be one compatible cut.
        # Revalidate on every page load so an App Service deployment cannot mix a
        # fresh app.js with an older cached helper API.
        response.headers["Cache-Control"] = "no-cache"
    return response

models.init_db(settings.database_url)

WEB_DIR = Path(__file__).resolve().parents[2] / "web"


# ---------------------------------------------------------------- db dep
def db() -> OrmSession:
    s = models.SessionLocal()
    try:
        yield s
    finally:
        s.close()


@app.get("/api/health", include_in_schema=False)
async def health():
    """Liveness only; intentionally contains no user or infrastructure data."""
    return {"status": "ok", "protocol_version": PROTOCOL_VERSION}


@app.get("/api/ready", include_in_schema=False)
async def ready(s: OrmSession = Depends(db)):
    """Readiness: database responds and the recording directory is writable."""
    try:
        s.execute(text("SELECT 1"))
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        if not os.access(settings.data_dir, os.W_OK):
            raise OSError("data directory is not writable")
    except Exception:
        raise HTTPException(503, "not ready")

    # Azure probes readiness continuously, so this also makes disk-pressure
    # warnings proactive without changing readiness or exposing local paths.
    report = collect_capacity(settings)
    observe_capacity(report, source="readiness_probe")
    return {"status": "ready", "protocol_version": PROTOCOL_VERSION}


@app.get("/api/version", include_in_schema=False)
async def version_public():
    """Public build provenance: marketing version + short commit only.

    Intentionally omits working-tree state and paths so it is safe to expose
    without authentication.
    """
    return version_info.public_version()


@app.get("/api/admin/version", include_in_schema=False)
async def version_detailed(request: Request, s: OrmSession = Depends(db)):
    """Operator build provenance (owner-only): full commit + dirty flag."""
    require_owner(request, s)
    return version_info.detailed_version()


@app.get("/api/admin/capacity", include_in_schema=False)
async def capacity_status(request: Request, s: OrmSession = Depends(db)):
    """Owner-only capacity report for the database and recording disk."""
    require_owner(request, s)
    report = collect_capacity(settings)
    observe_capacity(report, source="admin_api")
    return report.to_dict()


# ---------------------------------------------------------------- auth helpers
def current_user(request: Request, s: OrmSession) -> User:
    cookie = request.cookies.get("deepbox_session")
    if not cookie:
        raise HTTPException(401, "not logged in")
    try:
        data = signer.loads(cookie, max_age=settings.session_ttl_seconds)
    except SignatureExpired:
        raise HTTPException(401, "session expired")
    except BadSignature:
        raise HTTPException(401, "bad session")
    user = s.get(User, data.get("uid"))
    if not user:
        raise HTTPException(401, "user gone")
    if user.disabled_at is not None:
        raise HTTPException(403, "account disabled")
    return user


def require_owner(request: Request, s: OrmSession) -> User:
    u = current_user(request, s)
    if u.role != ROLE_OWNER:
        raise HTTPException(403, "owner only")
    return u


def _hash_secret(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _as_utc(value):
    """Normalize SQLite's timezone-naive UTC datetimes for safe comparison."""
    utc = now().tzinfo
    return value.replace(tzinfo=utc) if value.tzinfo is None else value.astimezone(utc)


def devbox_from_bearer(request: Request, s: OrmSession) -> Devbox:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "no bearer token")
    full = auth[7:].strip()
    tok = s.scalar(select(Token).where(Token.hash == hash_token(full)))
    if not tok or tok.revoked_at is not None:
        raise HTTPException(401, "invalid token")
    devbox = s.get(Devbox, tok.devbox_id)
    owner = s.get(User, devbox.owner_user_id) if devbox else None
    if not owner or owner.disabled_at is not None:
        raise HTTPException(401, "invalid token")
    tok.last_used_at = now()
    s.commit()
    return devbox


# ---------------------------------------------------------------- auth routes
def _user_json(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "email": user.email,
        "auth_provider": user.auth_provider,
        "disabled": user.disabled_at is not None,
        "disabled_at": (user.disabled_at.isoformat()
                        if user.disabled_at else None),
    }


def _set_session_cookie(response: Response, user: User) -> None:
    response.set_cookie(
        "deepbox_session", signer.dumps({"uid": user.id}),
        max_age=settings.session_ttl_seconds,
        httponly=True, samesite=settings.cookie_samesite,
        secure=settings.cookie_secure,
    )


def _microsoft_tenant_allowed(principal: MicrosoftPrincipal) -> bool:
    allowed_tenant_ids = settings.microsoft_allowed_tenant_ids
    return bool(principal.tenant_id) and (
        not allowed_tenant_ids
        or principal.tenant_id.casefold() in allowed_tenant_ids
    )


def _next_external_username(s: OrmSession, principal: MicrosoftPrincipal) -> str:
    base = normalize_username_hint(principal.email or principal.display_name)
    candidate = base
    suffix = 1
    while s.scalar(select(User.id).where(User.username == candidate)) is not None:
        suffix += 1
        candidate = f"{base[:42]}-{suffix}"
    return candidate


def _microsoft_user(s: OrmSession, principal: MicrosoftPrincipal) -> User:
    is_owner = principal.email in settings.microsoft_owner_emails
    user = s.scalar(select(User).where(
        User.auth_provider == "microsoft",
        User.external_tenant_id == principal.tenant_id,
        User.external_subject == principal.subject,
    ))
    if user is None:
        # An allow-listed Microsoft owner may claim a legacy local owner exactly
        # once.  Prefer an explicit email match, then a sole unlinked owner for
        # a safe migration from pre-identity deployments.
        # Linking by email is deliberately limited to an allowlisted owner
        # claiming an existing local owner account. Ordinary Microsoft users
        # always get a new external identity and join through invitations.
        if is_owner and principal.email:
            user = s.scalar(select(User).where(
                func.lower(User.email) == principal.email,
                User.role == ROLE_OWNER,
                User.external_subject.is_(None),
            ))
        if user is None and is_owner:
            owners = list(s.scalars(select(User).where(
                User.role == ROLE_OWNER, User.external_subject.is_(None))))
            if len(owners) == 1:
                user = owners[0]

        if user is None:
            user = User(
                id=new_id(), username=_next_external_username(s, principal),
                password_hash="!microsoft", display_name=principal.display_name,
                role=ROLE_OWNER if is_owner else ROLE_MEMBER,
            )
            s.add(user)
        elif is_owner:
            user.role = ROLE_OWNER
    elif is_owner:
        # The deployment allowlist is authoritative even when an identity was
        # first seen before it was selected as an owner.
        user.role = ROLE_OWNER

    if principal.email:
        user.email = principal.email
    user.auth_provider = "microsoft"
    user.external_tenant_id = principal.tenant_id
    user.external_subject = principal.subject

    # Commit the identity first so personal-workspace provisioning can safely
    # restart its transaction if another first-login request wins the race.
    try:
        s.flush()
        s.commit()
    except IntegrityError:
        s.rollback()
        winner = s.scalar(select(User).where(
            User.auth_provider == "microsoft",
            User.external_tenant_id == principal.tenant_id,
            User.external_subject == principal.subject,
        ))
        if winner is None:
            raise HTTPException(409, "identity conflict")
        user = winner

    # BootstrapState has its own singleton key and can race for an allow-listed
    # owner. Retry once after rolling back so the winner can be observed.
    for attempt in range(2):
        try:
            _ensure_personal_workspace(s, user)
            if user.role == ROLE_OWNER and s.get(BootstrapState, 1) is None:
                s.add(BootstrapState(id=1, owner_user_id=user.id))
            s.commit()
            break
        except (IntegrityError, OperationalError):
            s.rollback()
            if attempt == 1:
                raise
            reloaded = s.get(User, user.id)
            if reloaded is None:
                raise HTTPException(409, "identity conflict")
            user = reloaded
    return user


@app.get("/api/auth/config")
async def auth_config():
    return {
        "mode": settings.auth_mode,
        "password_enabled": settings.password_auth_enabled,
        "microsoft_enabled": settings.microsoft_auth_enabled,
        "microsoft_login_url": "/api/auth/microsoft/start",
        "microsoft_logout_url": "/api/auth/microsoft/logout",
    }


@app.get("/api/auth/microsoft/start")
async def microsoft_start():
    if not settings.microsoft_auth_enabled:
        raise HTTPException(404, "not found")
    callback = f"{(settings.public_url or '').rstrip('/')}/api/auth/microsoft/callback"
    from urllib.parse import quote
    return RedirectResponse(
        f"/.auth/login/aad?post_login_redirect_uri={quote(callback, safe='')}",
        status_code=302,
    )


@app.get("/api/auth/microsoft/callback")
async def microsoft_callback(request: Request, s: OrmSession = Depends(db)):
    if not settings.microsoft_auth_enabled:
        raise HTTPException(404, "not found")
    principal = build_microsoft_principal(request.headers)
    if principal is None:
        raise HTTPException(401, "Microsoft sign-in required")
    if not _microsoft_tenant_allowed(principal):
        raise HTTPException(403, "Microsoft tenant is not allowed")
    user = _microsoft_user(s, principal)
    if user.disabled_at is not None:
        raise HTTPException(403, "account disabled")
    audit_event("auth.microsoft_login", outcome="success",
                actor_user_id=user.id, request=request)
    response = RedirectResponse("/", status_code=302)
    _set_session_cookie(response, user)
    return response


@app.get("/api/auth/microsoft/logout")
async def microsoft_logout():
    if not settings.microsoft_auth_enabled:
        raise HTTPException(404, "not found")
    from urllib.parse import quote
    target = quote(f"{(settings.public_url or '').rstrip('/')}/", safe="")
    response = RedirectResponse(
        f"/.auth/logout?post_logout_redirect_uri={target}", status_code=302)
    response.delete_cookie("deepbox_session")
    return response


@app.post("/api/auth/register")
async def register(request: Request, s: OrmSession = Depends(db)):
    """Development-only self-registration.

    Production keeps AGENTBRIDGE_REGISTRATION_ENABLED=false; invitations are the
    onboarding mechanism there. When an invite code is supplied it is redeemed
    atomically and the created user is a member.
    """
    if not settings.password_auth_enabled:
        raise HTTPException(403, "password authentication disabled")
    body = await request.json()
    invite_code = (body.get("invite_code") or "").strip()
    username = body["username"].strip()
    if invite_code:
        return _redeem_invitation(s, invite_code, username, body, request)

    if s.scalar(select(User).where(User.username == username)):
        raise HTTPException(400, "username taken")
    if not settings.registration_enabled:
        raise HTTPException(403, "registration disabled")
    user = User(
        id=new_id(), username=username,
        password_hash=hash_password(body["password"]),
        display_name=body.get("display_name") or username,
        role=ROLE_MEMBER,
    )
    s.add(user)
    s.commit()
    return _login_response(user)


def _redeem_invitation(s: OrmSession, invite_code: str, username: str,
                       body: dict, request: Request) -> JSONResponse:
    # Keep every failed invitation claim opaque, including username conflicts,
    # so an untrusted code cannot be used as an account-enumeration oracle.
    if not username or not body.get("password"):
        raise HTTPException(404, "not found")
    if s.scalar(select(User.id).where(User.username == username)) is not None:
        raise HTTPException(404, "not found")
    token_hash = _hash_secret(invite_code)
    claim_time = now()
    user_id = new_id()
    user = User(
        id=user_id, username=username,
        password_hash=hash_password(body["password"]),
        display_name=body.get("display_name") or username,
        role=ROLE_MEMBER,
    )
    s.add(user)
    s.flush()
    # Atomic single-use redemption: only unredeemed, unrevoked, unexpired rows
    # can be claimed, and the row is stamped in the same conditional UPDATE.
    result = s.execute(
        text(
            "UPDATE invitation SET redeemed_at=:now, redeemed_by=:uid "
            "WHERE token_hash=:th AND redeemed_at IS NULL "
            "AND revoked_at IS NULL AND expires_at > :now"
        ),
        {"now": claim_time, "uid": user_id, "th": token_hash},
    )
    if result.rowcount != 1:
        s.rollback()
        raise HTTPException(404, "not found")
    s.commit()
    audit_event("invitation.redeemed", outcome="success", actor_user_id=user.id,
                request=request, resource_type="invitation",
                details={"username": username})
    return _login_response(user)


@app.post("/api/auth/login")
async def login(request: Request, s: OrmSession = Depends(db)):
    if not settings.password_auth_enabled:
        raise HTTPException(403, "password authentication disabled")
    body = await request.json()
    username = body["username"].strip()
    user = s.scalar(select(User).where(User.username == username))
    check = verify_password_ex(body["password"], user.password_hash) if user else None
    if not user or not check or not check.valid or user.disabled_at is not None:
        audit_event("auth.login", outcome="denied", request=request,
                    details={"username": username})
        raise HTTPException(401, "bad credentials")
    if check.replacement:
        user.password_hash = check.replacement
        s.commit()
    audit_event("auth.login", outcome="success", actor_user_id=user.id, request=request)
    return _login_response(user)


def _login_response(user: User) -> JSONResponse:
    response = JSONResponse(_user_json(user))
    _set_session_cookie(response, user)
    return response


@app.post("/api/auth/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("deepbox_session")
    return resp


@app.get("/api/me/user")
async def me_user(request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    return _user_json(u)


# ---------------------------------------------------------------- bootstrap
def _bootstrap_available(s: OrmSession) -> bool:
    """True only if local bootstrap is enabled, configured, and unused."""
    if not settings.password_auth_enabled or not settings.bootstrap_token_hash:
        return False
    if s.get(BootstrapState, 1) is not None:
        return False
    if s.scalar(select(User.id).limit(1)) is not None:
        return False
    return True


@app.get("/api/auth/bootstrap-status")
async def bootstrap_status(s: OrmSession = Depends(db)):
    """Safe boolean only — never echoes the token or hash."""
    return {"available": _bootstrap_available(s)}


@app.post("/api/auth/bootstrap")
async def bootstrap(request: Request, s: OrmSession = Depends(db)):
    """Create the first owner exactly once. Token compared by hash; response
    is a generic 404 for any invalid/unavailable case (no token echo/log)."""
    if not settings.password_auth_enabled:
        raise HTTPException(404, "not found")
    if not settings.bootstrap_token_hash:
        raise HTTPException(404, "not found")
    body = await request.json()
    provided = (body.get("token") or "")
    if not secrets.compare_digest(_hash_secret(provided), settings.bootstrap_token_hash):
        raise HTTPException(404, "not found")
    # Any pre-existing user makes bootstrap unavailable.
    if s.scalar(select(User.id).limit(1)) is not None:
        raise HTTPException(404, "not found")
    username = (body.get("username") or "").strip()
    if not username or not body.get("password"):
        raise HTTPException(404, "not found")
    user = User(
        id=new_id(), username=username,
        password_hash=hash_password(body["password"]),
        display_name=body.get("display_name") or username,
        role=ROLE_OWNER,
    )
    s.add(user)
    s.flush()
    # Insert the singleton latch in the SAME transaction as the owner. The
    # unique primary key (id=1) makes any concurrent claim lose.
    s.add(BootstrapState(id=1, owner_user_id=user.id))
    try:
        s.commit()
    except Exception:
        s.rollback()
        raise HTTPException(404, "not found")
    return _login_response(user)


# ---------------------------------------------------------------- invitations
def _invitation_json(inv: Invitation) -> dict:
    """Safe metadata only — never includes the token or its hash."""
    expired = _as_utc(inv.expires_at) <= now()
    return {
        "id": inv.id,
        "note": inv.note,
        "created_at": _as_utc(inv.created_at).isoformat(),
        "expires_at": _as_utc(inv.expires_at).isoformat(),
        "redeemed_at": _as_utc(inv.redeemed_at).isoformat() if inv.redeemed_at else None,
        "revoked_at": _as_utc(inv.revoked_at).isoformat() if inv.revoked_at else None,
        "status": ("revoked" if inv.revoked_at else
                   "redeemed" if inv.redeemed_at else
                   "expired" if expired else "active"),
    }


@app.post("/api/invitations")
async def create_invitation(request: Request, s: OrmSession = Depends(db)):
    u = require_owner(request, s)
    body = await request.json()
    ttl_hours = int(body.get("ttl_hours") or 24)
    ttl_hours = max(1, min(ttl_hours, 24 * 30))  # bounded TTL: 1h..30d
    import datetime as _dt
    raw = "deepbox_inv_" + secrets.token_hex(24)
    inv = Invitation(
        id=new_id(), token_hash=_hash_secret(raw), created_by=u.id,
        note=(body.get("note") or None),
        expires_at=now() + _dt.timedelta(hours=ttl_hours),
    )
    s.add(inv)
    s.commit()
    audit_event("invitation.created", actor_user_id=u.id,
                resource_type="invitation", resource_id=inv.id,
                details={"ttl_hours": ttl_hours})
    # Plaintext returned exactly once; never stored or logged.
    out = _invitation_json(inv)
    out["token"] = raw
    return out


@app.get("/api/invitations")
async def list_invitations(request: Request, s: OrmSession = Depends(db)):
    require_owner(request, s)
    rows = s.scalars(select(Invitation).order_by(Invitation.created_at.desc())).all()
    return [_invitation_json(i) for i in rows]


@app.delete("/api/invitations/{invitation_id}")
async def revoke_invitation(invitation_id: str, request: Request,
                            s: OrmSession = Depends(db)):
    actor = require_owner(request, s)
    inv = s.get(Invitation, invitation_id)
    if not inv:
        raise HTTPException(404, "not found")
    if inv.revoked_at is None and inv.redeemed_at is None:
        inv.revoked_at = now()
        s.commit()
    audit_event("invitation.revoked", actor_user_id=actor.id,
                resource_type="invitation", resource_id=inv.id)
    return {"ok": True}


# ---------------------------------------------------------------- user mgmt
def _enabled_owner_count(s: OrmSession, exclude_id: str | None = None) -> int:
    q = select(User).where(User.role == ROLE_OWNER, User.disabled_at.is_(None))
    return sum(1 for u in s.scalars(q).all() if u.id != exclude_id)


@app.get("/api/users")
async def list_users(request: Request, s: OrmSession = Depends(db)):
    require_owner(request, s)
    rows = s.scalars(select(User).order_by(User.created_at.asc())).all()
    return [_user_json(u) for u in rows]


@app.post("/api/users/{user_id}/disable")
async def disable_user(user_id: str, request: Request, s: OrmSession = Depends(db)):
    actor = require_owner(request, s)
    target = s.get(User, user_id)
    if not target:
        raise HTTPException(404, "not found")
    if target.disabled_at is not None:
        return _user_json(target)
    # Never disable the last enabled owner (covers self-lockout too).
    if target.role == ROLE_OWNER and _enabled_owner_count(s, exclude_id=target.id) == 0:
        raise HTTPException(400, "cannot disable the last enabled owner")
    target.disabled_at = now()
    devbox_ids = set(s.scalars(
        select(Devbox.id).where(Devbox.owner_user_id == target.id)
    ).all())
    s.commit()
    await hub.disconnect_user(target.id, devbox_ids)
    audit_event("user.disabled", actor_user_id=actor.id,
                resource_type="user", resource_id=target.id)
    return _user_json(target)


@app.post("/api/users/{user_id}/enable")
async def enable_user(user_id: str, request: Request, s: OrmSession = Depends(db)):
    actor = require_owner(request, s)
    target = s.get(User, user_id)
    if not target:
        raise HTTPException(404, "not found")
    target.disabled_at = None
    s.commit()
    audit_event("user.enabled", actor_user_id=actor.id,
                resource_type="user", resource_id=target.id)
    return _user_json(target)


# ---------------------------------------------------------------- devbox mgmt
@app.get("/api/workspaces")
async def list_workspaces(request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    # A shared invitation may be a user's first membership.  Personal workspace
    # creation is therefore keyed by the personal organization, not by whether
    # the user has any membership at all.
    _ensure_personal_workspace(s, u)
    s.commit()
    rows = list_user_workspaces(s, u.id)
    return [{"id": w.id, "name": w.name, "org_id": w.org_id,
             "role": get_role(s, w.id, u.id), "is_personal": bool(w.is_personal)}
            for w in rows]


@app.post("/api/workspaces")
async def create_workspace(request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    body = await request.json()
    name = str(body.get("name") or "").strip()[:120]
    if not name:
        raise HTTPException(422, "workspace name required")
    org = Organization(id=new_id(), name=name, owner_user_id=u.id)
    workspace = Workspace(id=new_id(), org_id=org.id, name=name)
    s.add_all([org, workspace, Membership(id=new_id(), workspace_id=workspace.id,
                                          user_id=u.id, role=WS_ROLE_OWNER)])
    s.commit()
    audit_event("workspace.created", actor_user_id=u.id,
                resource_type="workspace", resource_id=workspace.id)
    return {"id": workspace.id, "name": workspace.name, "role": WS_ROLE_OWNER}


@app.get("/api/workspaces/{workspace_id}/members")
async def list_workspace_members(workspace_id: str, request: Request,
                                 s: OrmSession = Depends(db)):
    u = current_user(request, s)
    _require_workspace(s, u.id, workspace_id)
    rows = s.execute(select(Membership, User).join(User, User.id == Membership.user_id)
                     .where(Membership.workspace_id == workspace_id)
                     .order_by(User.username)).all()
    return [{"user_id": m.user_id, "username": user.username, "role": m.role}
            for m, user in rows]


@app.post("/api/workspaces/{workspace_id}/members")
async def add_workspace_member(workspace_id: str, request: Request,
                               s: OrmSession = Depends(db)):
    actor = current_user(request, s)
    actor_role = _require_workspace(s, actor.id, workspace_id, WS_ROLE_ADMIN)
    body = await request.json()
    role = body.get("role", WS_ROLE_VIEWER)
    if role not in VALID_WS_ROLES or (role == WS_ROLE_OWNER and actor_role != WS_ROLE_OWNER):
        raise HTTPException(422, "invalid role")
    target = s.scalar(select(User).where(User.username == str(body.get("username", "")).strip()))
    if not target:
        raise HTTPException(404, "not found")
    if get_role(s, workspace_id, target.id):
        raise HTTPException(409, "already a member")
    s.add(Membership(id=new_id(), workspace_id=workspace_id, user_id=target.id, role=role))
    s.commit()
    audit_event("workspace.member_added", actor_user_id=actor.id,
                resource_type="workspace", resource_id=workspace_id,
                details={"target_user_id": target.id, "role": role})
    return {"user_id": target.id, "username": target.username, "role": role}


@app.patch("/api/workspaces/{workspace_id}/members/{user_id}")
async def update_workspace_member(workspace_id: str, user_id: str, request: Request,
                                  s: OrmSession = Depends(db)):
    actor = current_user(request, s)
    actor_role = _require_workspace(s, actor.id, workspace_id, WS_ROLE_ADMIN)
    membership = s.scalar(select(Membership).where(
        Membership.workspace_id == workspace_id, Membership.user_id == user_id))
    if not membership:
        raise HTTPException(404, "not found")
    body = await request.json()
    role = body.get("role")
    if role not in VALID_WS_ROLES:
        raise HTTPException(422, "invalid role")
    if (membership.role == WS_ROLE_OWNER or role == WS_ROLE_OWNER) and actor_role != WS_ROLE_OWNER:
        raise HTTPException(403, "owner role required")
    previous = membership.role
    if previous == WS_ROLE_OWNER and role != WS_ROLE_OWNER:
        owners = s.scalar(select(func.count()).select_from(Membership).where(
            Membership.workspace_id == workspace_id, Membership.role == WS_ROLE_OWNER))
        if owners <= 1:
            raise HTTPException(409, "workspace must keep an owner")
    session_ids = set(s.scalars(select(Session.id).where(
        Session.workspace_id == workspace_id)).all())
    membership.role = role
    s.commit()
    await hub.disconnect_user_sessions(user_id, session_ids)
    audit_event("workspace.role_changed", actor_user_id=actor.id,
                resource_type="workspace", resource_id=workspace_id,
                details={"target_user_id": user_id, "from": previous, "to": role})
    return {"user_id": user_id, "role": role}


@app.delete("/api/workspaces/{workspace_id}/members/{user_id}")
async def remove_workspace_member(workspace_id: str, user_id: str, request: Request,
                                  s: OrmSession = Depends(db)):
    actor = current_user(request, s)
    actor_role = _require_workspace(s, actor.id, workspace_id, WS_ROLE_ADMIN)
    membership = s.scalar(select(Membership).where(
        Membership.workspace_id == workspace_id, Membership.user_id == user_id))
    if not membership:
        raise HTTPException(404, "not found")
    if membership.role == WS_ROLE_OWNER and actor_role != WS_ROLE_OWNER:
        raise HTTPException(403, "owner role required")
    if membership.role == WS_ROLE_OWNER:
        owners = s.scalar(select(func.count()).select_from(Membership).where(
            Membership.workspace_id == workspace_id, Membership.role == WS_ROLE_OWNER))
        if owners <= 1:
            raise HTTPException(409, "workspace must keep an owner")
    session_ids = set(s.scalars(select(Session.id).where(
        Session.workspace_id == workspace_id)).all())
    s.delete(membership)
    s.commit()
    await hub.disconnect_user_sessions(user_id, session_ids)
    audit_event("workspace.member_removed", actor_user_id=actor.id,
                resource_type="workspace", resource_id=workspace_id,
                details={"target_user_id": user_id})
    return {"ok": True}


def _workspace_invitation_json(invite: WorkspaceInvitation) -> dict:
    return {
        "id": invite.id,
        "workspace_id": invite.workspace_id,
        "email": invite.email,
        "role": invite.role,
        "token_preview": invite.token_preview,
        "created_at": invite.created_at.isoformat(),
        "expires_at": invite.expires_at.isoformat(),
        "accepted_at": invite.accepted_at.isoformat() if invite.accepted_at else None,
        "revoked_at": invite.revoked_at.isoformat() if invite.revoked_at else None,
    }


def _active_workspace_invitation(s: OrmSession, token: str) -> WorkspaceInvitation:
    token = str(token or "").strip()
    if not token:
        raise HTTPException(404, "invitation not found")
    invite = s.scalar(select(WorkspaceInvitation).where(
        WorkspaceInvitation.token_hash == hash_token(token)))
    if (invite is None or invite.revoked_at is not None or
            invite.accepted_at is not None or _as_utc(invite.expires_at) <= now()):
        raise HTTPException(404, "invitation not found")
    return invite


@app.get("/api/workspaces/{workspace_id}/invitations")
async def list_workspace_invitations(workspace_id: str, request: Request,
                                     s: OrmSession = Depends(db)):
    actor = current_user(request, s)
    _require_workspace(s, actor.id, workspace_id, WS_ROLE_ADMIN)
    rows = s.scalars(select(WorkspaceInvitation).where(
        WorkspaceInvitation.workspace_id == workspace_id)
        .order_by(WorkspaceInvitation.created_at.desc())).all()
    return [_workspace_invitation_json(item) for item in rows]


@app.post("/api/workspaces/{workspace_id}/invitations")
async def create_workspace_invitation(workspace_id: str, request: Request,
                                      s: OrmSession = Depends(db)):
    actor = current_user(request, s)
    actor_role = _require_workspace(s, actor.id, workspace_id, WS_ROLE_ADMIN)
    workspace = s.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(404, "not found")
    body = await request.json()
    email = normalize_email(body.get("email"))
    role = str(body.get("role") or WS_ROLE_VIEWER)
    if email is None:
        raise HTTPException(422, "valid email required")
    if role not in (WS_ROLE_VIEWER, WS_ROLE_OPERATOR, WS_ROLE_ADMIN):
        raise HTTPException(422, "invalid role")
    if role == WS_ROLE_ADMIN and actor_role != WS_ROLE_OWNER:
        raise HTTPException(403, "owner role required")

    # Reissuing an invite invalidates earlier unclaimed links for this account.
    # Retry from a fresh transaction if another reissue changed our WAL snapshot.
    for attempt in range(3):
        issued_at = now()
        full, token_hash, preview = new_token()
        invite = WorkspaceInvitation(
            id=new_id(), workspace_id=workspace_id, email=email, role=role,
            token_hash=token_hash, token_preview=preview,
            created_by_user_id=actor.id, created_at=issued_at,
            expires_at=issued_at + dt.timedelta(
                days=settings.workspace_invitation_ttl_days),
        )
        try:
            # This is the first write. Concurrent reissues serialize here, and
            # the partial unique index is the final invariant backstop.
            s.execute(update(WorkspaceInvitation).where(
                WorkspaceInvitation.workspace_id == workspace_id,
                WorkspaceInvitation.email == email,
                WorkspaceInvitation.accepted_at.is_(None),
                WorkspaceInvitation.revoked_at.is_(None),
            ).values(revoked_at=issued_at))
            s.add(invite)
            s.commit()
            break
        except (IntegrityError, OperationalError):
            s.rollback()
            if attempt == 2:
                raise
            actor_role = _require_workspace(
                s, actor.id, workspace_id, WS_ROLE_ADMIN)
            if role == WS_ROLE_ADMIN and actor_role != WS_ROLE_OWNER:
                raise HTTPException(403, "owner role required")
    base = (settings.public_url or "").rstrip("/")
    join_url = f"{base}/#workspace-invite={full}" if base else f"/#workspace-invite={full}"
    audit_event("workspace.invitation_created", actor_user_id=actor.id,
                resource_type="workspace", resource_id=workspace_id,
                details={"role": role}, request=request)
    return {**_workspace_invitation_json(invite), "join_url": join_url}


@app.delete("/api/workspaces/{workspace_id}/invitations/{invitation_id}")
async def revoke_workspace_invitation(workspace_id: str, invitation_id: str,
                                      request: Request, s: OrmSession = Depends(db)):
    actor = current_user(request, s)
    _require_workspace(s, actor.id, workspace_id, WS_ROLE_ADMIN)
    invite = s.get(WorkspaceInvitation, invitation_id)
    if invite is None or invite.workspace_id != workspace_id:
        raise HTTPException(404, "not found")
    if invite.accepted_at is None and invite.revoked_at is None:
        invite.revoked_at = now()
        s.commit()
    audit_event("workspace.invitation_revoked", actor_user_id=actor.id,
                resource_type="workspace", resource_id=workspace_id,
                request=request)
    return {"ok": True}


@app.post("/api/workspace-invitations/preview")
async def preview_workspace_invitation(request: Request,
                                           s: OrmSession = Depends(db)):
    actor = current_user(request, s)
    body = await request.json()
    invite = _active_workspace_invitation(s, body.get("token"))
    workspace = s.get(Workspace, invite.workspace_id)
    if workspace is None:
        raise HTTPException(404, "invitation not found")
    local, _, domain = invite.email.partition("@")
    masked = f"{local[:1]}***@{domain}" if domain else "***"
    audit_event("workspace.invitation_previewed", actor_user_id=actor.id,
                resource_type="workspace", resource_id=workspace.id,
                request=request)
    return {"workspace_id": workspace.id, "workspace_name": workspace.name,
            "email_hint": masked, "role": invite.role,
            "expires_at": invite.expires_at.isoformat()}


@app.post("/api/workspace-invitations/accept")
async def accept_workspace_invitation(request: Request,
                                      s: OrmSession = Depends(db)):
    actor = current_user(request, s)
    body = await request.json()
    raw_token = str(body.get("token") or "").strip()
    actor_email = normalize_email(actor.email)
    if not actor_email:
        raise HTTPException(403, "Microsoft account email required")

    token_hash = hash_token(raw_token)
    claimed = False
    for attempt in range(3):
        accepted_at = now()
        try:
            result = s.execute(update(WorkspaceInvitation).where(
                WorkspaceInvitation.token_hash == token_hash,
                WorkspaceInvitation.email == actor_email,
                WorkspaceInvitation.accepted_at.is_(None),
                WorkspaceInvitation.revoked_at.is_(None),
                WorkspaceInvitation.expires_at > accepted_at,
            ).values(
                accepted_at=accepted_at,
                accepted_by_user_id=actor.id,
            ))
            if result.rowcount == 1:
                claimed = True
                break
            s.rollback()
            break
        except OperationalError:
            s.rollback()
            if attempt == 2:
                raise

    if not claimed:
        invite = s.scalar(select(WorkspaceInvitation).where(
            WorkspaceInvitation.token_hash == token_hash))
        # Replaying the same successfully accepted link is idempotent.  It
        # never recreates a membership that was subsequently removed.
        if (invite is not None
                and invite.accepted_by_user_id == actor.id
                and invite.email == actor_email):
            existing = s.scalar(select(Membership).where(
                Membership.workspace_id == invite.workspace_id,
                Membership.user_id == actor.id,
            ))
            workspace = s.get(Workspace, invite.workspace_id)
            if existing is not None and workspace is not None:
                return {
                    "workspace": {
                        "id": workspace.id, "name": workspace.name,
                    },
                    "role": existing.role,
                    "already_member": True,
                }
        if (invite is not None
                and invite.accepted_at is None
                and invite.revoked_at is None
                and _as_utc(invite.expires_at) > now()
                and invite.email != actor_email):
            raise HTTPException(403, "invitation email does not match")
        raise HTTPException(404, "invitation not found")

    invite = s.scalar(select(WorkspaceInvitation).where(
        WorkspaceInvitation.token_hash == token_hash))
    if invite is None:
        s.rollback()
        raise HTTPException(404, "invitation not found")
    workspace = s.get(Workspace, invite.workspace_id)
    if workspace is None:
        s.rollback()
        raise HTTPException(404, "invitation not found")

    existing = s.scalar(select(Membership).where(
        Membership.workspace_id == invite.workspace_id,
        Membership.user_id == actor.id,
    ))
    already_member = existing is not None
    if existing is None:
        candidate = Membership(
            id=new_id(), workspace_id=invite.workspace_id,
            user_id=actor.id, role=invite.role,
        )
        try:
            # Keep the invitation claim if another path concurrently adds the
            # same membership; only the nested insertion is rolled back.
            with s.begin_nested():
                s.add(candidate)
                s.flush()
            existing = candidate
        except IntegrityError:
            existing = s.scalar(select(Membership).where(
                Membership.workspace_id == invite.workspace_id,
                Membership.user_id == actor.id,
            ))
            if existing is None:
                s.rollback()
                raise
            already_member = True
    s.commit()
    audit_event("workspace.invitation_accepted", actor_user_id=actor.id,
                resource_type="workspace", resource_id=invite.workspace_id,
                details={"role": invite.role}, request=request)
    return {
        "workspace": {
            "id": workspace.id, "name": workspace.name,
        },
        "role": existing.role,
        "already_member": already_member,
    }


def _agent_json(a: Agent) -> dict:
    return {"id": a.id, "handle": a.handle, "display_name": a.display_name,
            "runtime": a.runtime, "local_project_id": a.local_project_id,
            "runtime_config": a.runtime_config or {},
            "runtime_status": a.runtime_status,
            "renderer": runtime_policy(a.runtime).renderer,
            # Legacy bridge only: the connector imports this path locally and a
            # successful project report clears it from the server.
            "cwd": a.cwd, "launch_cmd": a.launch_cmd,
            "presence": "online" if hub.is_agent_online(a.id) else "offline"}


def _project_json(project: DevboxProject) -> dict:
    """Path-free project metadata safe to expose through the control plane."""
    return {"id": project.id, "name": project.name,
            "runtime_config": project.runtime_config or {}}


def _connector_agent_dir(agents: list[Agent]) -> list[dict]:
    """Agent directory in the shape the connector's supervisor consumes.

    Mirrors the ``/api/me`` payload so a live-pushed ``agents`` frame and a
    fresh bootstrap produce an identical runtime lookup on the connector.
    """
    return [{"id": a.id, "handle": a.handle, "runtime": a.runtime,
             "local_project_id": a.local_project_id,
             "runtime_config": a.runtime_config or {},
             "runtime_status": a.runtime_status,
             "renderer": runtime_policy(a.runtime).renderer,
             "cwd": a.cwd, "launch_cmd": a.launch_cmd}
            for a in agents]


async def _broadcast_runtime_status(s: OrmSession, agent: Agent) -> None:
    """Use the existing bounded human channel, scoped to workspace membership."""
    notification = runtime_policy(agent.runtime).status_notification(agent)
    if notification is None:
        return
    d = s.get(Devbox, agent.devbox_id)
    if d is None:
        return
    user_ids = set(s.scalars(select(Membership.user_id).join(
        User, User.id == Membership.user_id).where(
        Membership.workspace_id == d.workspace_id, User.disabled_at.is_(None))))
    await hub.to_users(user_ids, notification)


async def _accept_runtime_status(s: OrmSession, conn: DevboxConn, frame: dict) -> bool:
    """Only a current owning Connector can report this desired binding's state."""
    if not hub.is_current_devbox(conn):
        return False
    aid = frame.get("agent_id")
    if not isinstance(aid, str) or len(aid) > 64 or aid not in conn.agent_ids:
        return False
    # WebSocket sessions keep objects across frames (expire_on_commit=False).
    # A rollback with no open transaction does not expire them, so explicitly
    # refresh desired configuration before accepting any observed revision.
    agent = s.get(Agent, aid, populate_existing=True)
    if not agent or agent.devbox_id != conn.devbox_id:
        return False
    accepted = runtime_policy(agent.runtime).observed_status(agent, frame.get("runtime_status"))
    if accepted is None:
        return False
    if agent.runtime_status == accepted:
        return True
    agent.runtime_status = accepted
    s.commit()
    await _broadcast_runtime_status(s, agent)
    return True


_agent_directory_locks: dict[str, asyncio.Lock] = {}


async def _push_agent_directory(devbox_id: str) -> None:
    """Queue an authoritative agent set for an online connector.

    Per-devbox serialization prevents two concurrent create/delete requests
    from publishing full-directory snapshots out of order. A short-lived
    session makes each snapshot fresh and avoids holding a read transaction
    open for the lifetime of a connector WebSocket.
    """
    lock = _agent_directory_locks.setdefault(devbox_id, asyncio.Lock())
    async with lock:
        directory_db = models.SessionLocal()
        try:
            agents = list(directory_db.scalars(
                select(Agent).where(Agent.devbox_id == devbox_id)
                .order_by(Agent.created_at, Agent.id)
            ).all())
        finally:
            directory_db.close()
        directory = _connector_agent_dir(agents)
        await hub.sync_agents(devbox_id, {a.id for a in agents}, directory)


def _ensure_personal_workspace(s: OrmSession, u: User) -> Workspace:
    """Return the user's singleton personal workspace, creating it safely.

    Partial unique indexes enforce the singleton invariant.  SQLite WAL can
    reject a read-to-write upgrade when another request wins the same race, so
    retry from a fresh transaction after either a uniqueness or snapshot error.
    Callers invoke this before making other request-scoped mutations.
    """
    user_id = u.id
    username = u.username
    for attempt in range(3):
        try:
            workspace = s.scalar(select(Workspace).join(
                Organization, Workspace.org_id == Organization.id).where(
                    Organization.owner_user_id == user_id,
                    Organization.is_personal.is_(True),
                    Workspace.is_personal.is_(True),
                ))
            if workspace is None:
                org = s.scalar(select(Organization).where(
                    Organization.owner_user_id == user_id,
                    Organization.is_personal.is_(True),
                ))
                if org is None:
                    org = Organization(
                        id=new_id(), name=f"{username}'s organization",
                        is_personal=True, owner_user_id=user_id)
                    s.add(org)
                    s.flush()
                workspace = s.scalar(select(Workspace).where(
                    Workspace.org_id == org.id,
                    Workspace.is_personal.is_(True),
                ))
                if workspace is None:
                    workspace = Workspace(
                        id=new_id(), org_id=org.id, name="Personal",
                        is_personal=True)
                    s.add(workspace)
                    s.flush()
            membership = s.scalar(select(Membership).where(
                Membership.workspace_id == workspace.id,
                Membership.user_id == user_id,
            ))
            if membership is None:
                s.add(Membership(
                    id=new_id(), workspace_id=workspace.id,
                    user_id=user_id, role=WS_ROLE_OWNER))
                s.flush()
            return workspace
        except (IntegrityError, OperationalError):
            s.rollback()
            if attempt == 2 or s.get(User, user_id) is None:
                raise
    raise RuntimeError("personal workspace provisioning retry exhausted")


def _require_workspace(s: OrmSession, user_id: str, workspace_id: str,
                       minimum: str = WS_ROLE_VIEWER) -> str:
    try:
        return require_workspace_access(s, workspace_id, user_id, minimum)
    except PermissionDenied:
        raise HTTPException(404, "not found")


def _devbox_role(s: OrmSession, user_id: str, d: Devbox,
                 minimum: str = WS_ROLE_VIEWER) -> str:
    if not d.workspace_id:
        if d.owner_user_id == user_id:
            return WS_ROLE_OWNER
        raise HTTPException(404, "not found")
    return _require_workspace(s, user_id, d.workspace_id, minimum)


def _session_role(s: OrmSession, user_id: str, sess: Session,
                  minimum: str = WS_ROLE_VIEWER) -> str:
    user = s.get(User, user_id, populate_existing=True) if isinstance(user_id, str) else None
    if not user or user.disabled_at is not None:
        raise HTTPException(403, "user is disabled or unavailable")
    if sess.workspace_id:
        return _require_workspace(s, user_id, sess.workspace_id, minimum)
    if sess.user_id == user_id:
        return WS_ROLE_OWNER
    raise HTTPException(404, "not found")


def _lease_json(s: OrmSession, sess: Session, user_id: str, role: str) -> dict:
    required = sess.surface != "structured"
    lease = get_keyboard_lease(s, sess.id) if required else None
    active = bool(lease and not lease_is_expired(lease, now()))
    holder = s.get(User, lease.holder_user_id) if active else None
    return {"type": "collaboration", "session_id": sess.id, "role": role,
            "surface": sess.surface,
            "keyboard": {"required": required,
                         "holder_user_id": lease.holder_user_id if active else None,
                         "holder_username": holder.username if holder else None,
                         "expires_at": lease.expires_at.isoformat() if active else None,
                         "is_holder": bool(active and lease.holder_user_id == user_id),
                         "can_request": required and can_control(role)}}


def _devbox_json(d: Devbox) -> dict:
    return {"id": d.id, "name": d.name, "workspace_id": d.workspace_id,
            "online": hub.is_devbox_online(d.id),
            "last_seen_at": d.last_seen_at.isoformat() if d.last_seen_at else None,
            "capabilities": d.capabilities,
            "skills": d.skills or [],
            "projects": [_project_json(p) for p in d.projects],
            "agents": [_agent_json(a) for a in d.agents]}


@app.post("/api/devboxes")
async def create_devbox(request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    body = await request.json()
    workspace_id = body.get("workspace_id")
    if workspace_id:
        _require_workspace(s, u.id, workspace_id, WS_ROLE_ADMIN)
        workspace = s.get(Workspace, workspace_id)
    else:
        workspace = _ensure_personal_workspace(s, u)
    d = Devbox(id=new_id(), owner_user_id=u.id, workspace_id=workspace.id,
               name=body.get("name") or "My Devbox")
    s.add(d)
    full, h, preview = new_token()
    s.add(Token(id=new_id(), devbox_id=d.id, hash=h, preview=preview))
    s.commit()
    audit_event("devbox.created", actor_user_id=u.id,
                resource_type="devbox", resource_id=d.id,
                details={"workspace_id": workspace.id})
    return {"devbox": _devbox_json(d), "token": full, "token_preview": preview}


@app.get("/api/devboxes")
async def list_devboxes(request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    workspace_ids = select(Membership.workspace_id).where(Membership.user_id == u.id)
    rows = s.scalars(select(Devbox).where(Devbox.workspace_id.in_(workspace_ids))).all()
    legacy = s.scalars(select(Devbox).where(Devbox.workspace_id.is_(None),
                                             Devbox.owner_user_id == u.id)).all()
    return [_devbox_json(d) for d in [*rows, *legacy]]


@app.delete("/api/devboxes/{devbox_id}")
async def delete_devbox(devbox_id: str, request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    d = s.get(Devbox, devbox_id)
    if not d:
        raise HTTPException(404, "not found")
    _devbox_role(s, u.id, d, WS_ROLE_ADMIN)
    s.delete(d)
    s.commit()
    return {"ok": True}


def _token_json(token: Token) -> dict:
    return {"id": token.id, "preview": token.preview,
            "created_at": token.created_at.isoformat(),
            "last_used_at": token.last_used_at.isoformat() if token.last_used_at else None,
            "revoked_at": token.revoked_at.isoformat() if token.revoked_at else None}


@app.get("/api/devboxes/{devbox_id}/tokens")
async def list_tokens(devbox_id: str, request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    d = s.get(Devbox, devbox_id)
    if not d:
        raise HTTPException(404, "not found")
    _devbox_role(s, u.id, d, WS_ROLE_ADMIN)
    rows = s.scalars(select(Token).where(Token.devbox_id == d.id)
                     .order_by(Token.created_at.desc())).all()
    return [_token_json(row) for row in rows]


@app.post("/api/devboxes/{devbox_id}/tokens")
async def rotate_token(devbox_id: str, request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    d = s.get(Devbox, devbox_id)
    if not d:
        raise HTTPException(404, "not found")
    _devbox_role(s, u.id, d, WS_ROLE_ADMIN)
    issued_at = now()
    for token in s.scalars(select(Token).where(
            Token.devbox_id == d.id, Token.revoked_at.is_(None))).all():
        token.revoked_at = issued_at
    full, h, preview = new_token()
    token = Token(id=new_id(), devbox_id=d.id, hash=h, preview=preview)
    s.add(token)
    s.commit()
    await hub.disconnect_devbox(d.id)
    audit_event("devbox.token_rotated", actor_user_id=u.id,
                resource_type="devbox", resource_id=d.id)
    return {"token": full, "token_preview": preview, "token_id": token.id}


@app.delete("/api/devboxes/{devbox_id}/tokens/{token_id}")
async def revoke_token(devbox_id: str, token_id: str, request: Request,
                       s: OrmSession = Depends(db)):
    u = current_user(request, s)
    d = s.get(Devbox, devbox_id)
    token = s.get(Token, token_id)
    if not d or not token or token.devbox_id != d.id:
        raise HTTPException(404, "not found")
    _devbox_role(s, u.id, d, WS_ROLE_ADMIN)
    if token.revoked_at is None:
        token.revoked_at = now()
        s.commit()
        await hub.disconnect_devbox(d.id)
    audit_event("devbox.token_revoked", actor_user_id=u.id,
                resource_type="token", resource_id=token.id,
                details={"devbox_id": d.id})
    return {"ok": True}


@app.post("/api/devboxes/{devbox_id}/agents")
async def create_agent(devbox_id: str, request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    d = s.get(Devbox, devbox_id)
    if not d:
        raise HTTPException(404, "not found")
    _devbox_role(s, u.id, d, WS_ROLE_ADMIN)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(422, "expected a JSON object")
    policy = runtime_policy(body.get("runtime"))
    policy.validate_create_fields(body)
    local_project_id = body.get("local_project_id") or None
    if local_project_id is not None and (not isinstance(local_project_id, str) or len(local_project_id) > 64):
        raise HTTPException(422, "invalid local project id")
    policy.validate_local_project(local_project_id)
    if local_project_id:
        project = s.get(DevboxProject, local_project_id)
        if not project or project.devbox_id != d.id:
            raise HTTPException(422, "local project does not belong to this devbox")
    runtime_config = policy.create_config(body)
    if not isinstance(runtime_config, dict):
        raise HTTPException(422, "runtime_config must be an object")
    if len(json.dumps(runtime_config)) > 16 * 1024:
        raise HTTPException(422, "runtime_config is too large")
    policy.validate_create_capabilities(runtime_config, d.capabilities)
    a = Agent(
        id=new_id(), devbox_id=d.id,
        handle=body["handle"], display_name=body.get("display_name") or body["handle"],
        runtime=body.get("runtime", "mock"),
        local_project_id=local_project_id, runtime_config=runtime_config,
        cwd=body.get("cwd"), launch_cmd=body.get("launch_cmd"),
    )
    s.add(a)
    policy.initialize_agent(a)
    s.commit()
    await _push_agent_directory(d.id)
    await _broadcast_runtime_status(s, a)
    return _agent_json(a)


@app.get("/api/agents/{agent_id}")
async def get_agent(agent_id: str, request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    a = s.get(Agent, agent_id)
    if not a:
        raise HTTPException(404, "not found")
    _devbox_role(s, u.id, a.devbox)
    return _agent_json(a)


def _agent_has_active_sessions(s: OrmSession, agent: Agent) -> bool:
    """Include idle attached conversations, not just running Connector turns.

    A stored historical session alone does not block settings. Open viewers and
    queued input do: replacing configuration must never terminate their work.
    """
    for sid in s.scalars(select(Session.id).where(Session.agent_id == agent.id)):
        if hub.is_session_active(agent.id, sid):
            return True
        live_session = live_registry.get(sid)
        if live_session is not None and live_session.ended:
            continue
        if hub.session_watchers.get(sid) or (live_session and live_session.pending_inputs):
            return True
    return False


@app.patch("/api/agents/{agent_id}")
async def rename_agent(agent_id: str, request: Request, s: OrmSession = Depends(db)):
    """Apply authorized display edits and policy-approved desired settings."""
    u = current_user(request, s)
    a = s.get(Agent, agent_id)
    if not a:
        raise HTTPException(404, "not found")
    _devbox_role(s, u.id, a.devbox, WS_ROLE_ADMIN)
    body = await _session_body(request)
    policy = runtime_policy(a.runtime)
    runtime_config = policy.validate_agent_update(a, body)
    if runtime_config is not None:
        if len(json.dumps(runtime_config)) > 16 * 1024:
            raise HTTPException(422, "runtime_config is too large")
        if _agent_has_active_sessions(s, a):
            raise HTTPException(409, "close active conversations before changing runtime configuration")
    if "display_name" in body:
        name = body["display_name"]
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise HTTPException(422, "display_name must be a nonempty string of at most 200 characters")
        a.display_name = name.strip()
    if runtime_config is not None:
        a.runtime_config = runtime_config
        policy.initialize_agent(a)
    s.commit()
    await _push_agent_directory(a.devbox_id)
    if runtime_config is not None:
        await _broadcast_runtime_status(s, a)
    return _agent_json(a)


@app.post("/api/agents/{agent_id}/runtime/retry")
async def retry_agent_runtime(agent_id: str, request: Request, s: OrmSession = Depends(db)):
    """Resend the exact desired binding; no credentials or config updates."""
    u = current_user(request, s)
    a = s.get(Agent, agent_id)
    if not a:
        raise HTTPException(404, "not found")
    _devbox_role(s, u.id, a.devbox, WS_ROLE_ADMIN)
    policy = runtime_policy(a.runtime)
    policy.require_retry()
    policy.retry_agent(a, await _session_body(request))
    s.commit()
    await _push_agent_directory(a.devbox_id)
    await _broadcast_runtime_status(s, a)
    return _agent_json(a)


@app.delete("/api/agents/{agent_id}")
async def delete_agent(agent_id: str, request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    a = s.get(Agent, agent_id)
    if not a:
        raise HTTPException(404, "not found")
    _devbox_role(s, u.id, a.devbox, WS_ROLE_ADMIN)
    devbox_id = a.devbox_id
    session_ids = {
        row[0] for row in s.query(Session.id).filter(Session.agent_id == a.id).all()
    }
    s.delete(a)
    s.commit()
    await hub.retire_agent_sessions(a.id, session_ids)
    for session_id in session_ids:
        live_registry.drop(session_id)
    await _push_agent_directory(devbox_id)
    return {"ok": True}


# ---------------------------------------------------------------- sessions
def _surface_hint(body: dict) -> str | None:
    surface = body.get("surface")
    if surface not in (None, "terminal", "structured"):
        raise HTTPException(400, "surface must be terminal or structured")
    return surface


async def _session_body(request: Request) -> dict:
    try:
        body = await request.json() if await request.body() else {}
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "expected a JSON object") from None
    if not isinstance(body, dict):
        raise HTTPException(400, "expected a JSON object")
    return body


def _session_features(sess: Session) -> dict:
    """Read only generic reported feature keys, never runtime-name semantics."""
    store = object_session(sess)
    agent = store.get(Agent, sess.agent_id) if store is not None else None
    devbox = store.get(Devbox, agent.devbox_id) if agent is not None else None
    capabilities = devbox.capabilities if devbox is not None else []
    for capability in capabilities if isinstance(capabilities, list) else []:
        if not isinstance(capability, dict):
            continue
        aliases = capability.get("legacy_runtime_ids", [])
        if (capability.get("runtime") != agent.runtime
                and not (isinstance(aliases, list) and agent.runtime in aliases)):
            continue
        surfaces = capability.get("surfaces", [])
        for surface in surfaces if isinstance(surfaces, list) else []:
            if isinstance(surface, dict) and surface.get("id") == sess.surface:
                features = surface.get("features")
                return features if isinstance(features, dict) else {}
    return {}


def _native_resume_supported(sess: Session) -> bool:
    features = _session_features(sess)
    context = features.get("context", {})
    if (sess.surface == "structured" and features.get("session_lifecycle") == 1
            and isinstance(context, dict) and context.get("continuity") == "native"
            and context.get("available") is True):
        store = object_session(sess)
        agent = store.get(Agent, sess.agent_id) if store is not None else None
        return bool(agent and runtime_policy(agent.runtime).library_continuation)
    return (sess.surface == "structured" and features.get("session_lifecycle") == 1
            and isinstance(context, dict) and context.get("continuity") == "native_resume"
            and context.get("available") is True and context.get("explicit_resume") is True)


def _session_json(sess: Session, agent: Agent | None = None, *, role: str | None = None) -> dict:
    ls = live_registry.get(sess.id)
    state = ("live" if hub.is_session_active(sess.agent_id, sess.id)
             else "ended" if ls and ls.ended else "inactive")
    supported = _native_resume_supported(sess)
    operator = can_control(role) if role else False
    online = hub.is_agent_online(sess.agent_id)
    reason = ("Operator access is required to resume." if not operator else
              "This machine is offline." if not online else
              "This session does not report explicit native resume support. "
              "Update the connector or start a new session." if not supported else "")
    result = {"id": sess.id, "agent_id": sess.agent_id, "title": sess.title,
              "surface": sess.surface, "created_at": sess.created_at.isoformat(),
              "state": state, "launch_id": sess.launch_id,
              "can_rename": operator, "resume_supported": supported,
              "can_resume": operator and online and supported, "resume_reason": reason}
    if agent is not None:
        result.update(runtime_policy(agent.runtime).session_fields(agent))
    return result


@app.get("/api/agents/{agent_id}/sessions")
async def list_agent_sessions(agent_id: str, request: Request,
                              s: OrmSession = Depends(db)):
    """List resumable sessions newest-first; opening an agent must not silently
    create a new terminal and hide the persisted one."""
    u = current_user(request, s)
    a = s.get(Agent, agent_id)
    if not a:
        raise HTTPException(404, "not found")
    _devbox_role(s, u.id, a.devbox)
    rows = s.scalars(select(Session).where(
        Session.agent_id == agent_id
    ).order_by(Session.created_at.desc())).all()
    return [_session_json(sess, a, role=_session_role(s, u.id, sess)) for sess in rows]


@app.post("/api/agents/{agent_id}/sessions")
async def create_session(agent_id: str, request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    a = s.get(Agent, agent_id)
    if not a:
        raise HTTPException(404, "not found")
    role = _devbox_role(s, u.id, a.devbox, WS_ROLE_OPERATOR)
    surface = _surface_hint(await _session_body(request))
    surface = runtime_policy(a.runtime).session_surface(surface)
    # Canonical UUID text for new native CLI handles. Existing IDs never change.
    sess = Session(id=str(uuid4()), user_id=u.id, agent_id=a.id,
                   workspace_id=a.devbox.workspace_id, title=f"{a.display_name} session",
                   surface=surface)
    s.add(sess)
    s.commit()
    return _session_json(sess, a, role=role)


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str, request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    sess = s.get(Session, session_id)
    if not sess:
        raise HTTPException(404, "not found")
    role = _session_role(s, u.id, sess)
    return _session_json(sess, s.get(Agent, sess.agent_id), role=role)


@app.patch("/api/sessions/{session_id}")
async def rename_session(session_id: str, request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    sess = s.get(Session, session_id)
    if not sess:
        raise HTTPException(404, "not found")
    role = _session_role(s, u.id, sess, WS_ROLE_OPERATOR)
    body = await _session_body(request)
    title, expected = body.get("title"), body.get("expected_title")
    if (set(body) != {"title", "expected_title"} or not isinstance(title, str)
            or not isinstance(expected, str) or len(expected) > 512):
        raise HTTPException(400, "title and expected_title are required; only the display title can change")
    title = title.strip()
    if (not title or len(title) > 120
            or any(ord(ch) < 32 or 127 <= ord(ch) <= 159 or ch in "\u2028\u2029" for ch in title)):
        raise HTTPException(400, "title must be a single line of 1 to 120 characters")
    changed = s.execute(update(Session).where(
        Session.id == session_id, Session.title == expected).values(title=title))
    if changed.rowcount != 1:
        s.rollback()
        raise HTTPException(409, "The title changed. Refresh it before saving your edit.")
    s.commit()
    s.refresh(sess)
    audit_event("session.renamed", actor_user_id=u.id, resource_type="session", resource_id=sess.id)
    await hub.to_session_humans(sess.id, {
        "type": "session.updated", "session_id": sess.id, "title": sess.title})
    return _session_json(sess, s.get(Agent, sess.agent_id), role=role)


def _require_terminal_keyboard(sess: Session) -> None:
    if sess.surface == "structured":
        raise HTTPException(400, "structured sessions do not use a keyboard lease")


@app.post("/api/sessions/{session_id}/keyboard")
async def session_keyboard(session_id: str, request: Request,
                           s: OrmSession = Depends(db)):
    u = current_user(request, s)
    sess = s.get(Session, session_id)
    if not sess:
        raise HTTPException(404, "not found")
    role = _session_role(s, u.id, sess, WS_ROLE_OPERATOR)
    _require_terminal_keyboard(sess)
    body = await _session_body(request)
    try:
        _change_keyboard(s, sess, u.id, role, body.get("action", "acquire"),
                         body.get("target_user_id"))
    except (PermissionDenied, LeaseError) as exc:
        s.rollback()
        raise HTTPException(409 if isinstance(exc, LeaseConflict) else 403, str(exc)) from None
    await _broadcast_collaboration(s, sess)
    return _lease_json(s, sess, u.id, role)


@app.get("/api/sessions/{session_id}/messages")
async def session_messages(session_id: str, request: Request, s: OrmSession = Depends(db)):
    u = current_user(request, s)
    sess = s.get(Session, session_id)
    if not sess:
        raise HTTPException(404, "not found")
    _session_role(s, u.id, sess)
    rows = s.scalars(select(Message).where(Message.session_id == session_id)
                     .order_by(Message.created_at)).all()
    return [{"id": m.id, "author_kind": m.author_kind, "author_id": m.author_id,
             "body": m.body, "created_at": m.created_at.isoformat()} for m in rows]


@app.get("/api/sessions/{session_id}/recording")
async def session_recording(session_id: str, request: Request, s: OrmSession = Depends(db)):
    """Return the asciicast v2 DVR recording for replay/audit.

    Merges legacy .cast history with durable Protocol v3 output frames so each
    event appears exactly once, in deterministic order.
    """
    u = current_user(request, s)
    sess = s.get(Session, session_id)
    if not sess:
        raise HTTPException(404, "not found")
    _session_role(s, u.id, sess)
    from .live import cast_header, DATA_DIR
    from fastapi.responses import PlainTextResponse
    merged = live_registry.merged_events(session_id)
    cast_path = DATA_DIR / f"{session_id}.cast"
    if not merged and not cast_path.exists():
        raise HTTPException(404, "no recording")
    lines = [json.dumps(cast_header(session_id))]
    for ev in merged:
        lines.append(json.dumps([ev[0], ev[1], ev[2]]))
    return PlainTextResponse("\n".join(lines) + "\n",
                             media_type="application/x-asciicast")


@app.get("/api/sessions/{session_id}/replay")
async def session_replay(session_id: str, request: Request,
                         s: OrmSession = Depends(db)):
    """Owner-scoped structured replay payload for the browser replay UI.

    Returns the asciicast header, the ordered durable event list (redacted
    frames are omitted so redacted payload can never leak), and persisted
    checkpoints keyed by durable frame cursor to support O(1) seek.
    """
    u = current_user(request, s)
    sess = s.get(Session, session_id)
    if not sess:
        raise HTTPException(404, "not found")
    _session_role(s, u.id, sess)
    from .live import cast_header

    header = cast_header(session_id)
    cols = header.get("width", 80)
    rows = header.get("height", 24)

    frames = recording_store.read_range(s, session_id)  # non-redacted, by id
    events = []
    last = 0.0
    for idx, f in enumerate(frames):
        t = f.elapsed if f.elapsed is not None else last
        if t < last:
            t = last
        last = t
        events.append({
            "index": idx,
            "frame_id": f.id,
            "time": round(float(t), 6),
            "kind": f.kind or "o",
            "data": f.data,
        })

    checkpoints = []
    for cp in recording_store.checkpoints(s, session_id):
        checkpoints.append({
            "frame_id": cp.frame_id,
            "event_index": cp.event_index,
            "time": round(float(cp.elapsed), 6) if cp.elapsed is not None else None,
            "cols": cp.cols,
            "rows": cp.rows,
            "screen": cp.screen,
        })

    meta = recording_store.metadata(s, session_id)
    return {
        "session_id": session_id,
        "header": header,
        "cols": cols,
        "rows": rows,
        "retention": getattr(sess, "retention", None),
        "duration": round(float(last), 6),
        "event_count": len(events),
        "events": events,
        "checkpoints": checkpoints,
        "metadata": {
            "frame_count": meta["frame_count"],
            "redacted_count": meta["redacted_count"],
            "pty_instance_ids": meta["pty_instance_ids"],
        },
    }


@app.delete("/api/sessions/{session_id}/recording")
async def erase_session_recording(session_id: str, request: Request,
                                  s: OrmSession = Depends(db)):
    u = current_user(request, s)
    sess = s.get(Session, session_id)
    if not sess:
        raise HTTPException(404, "not found")
    _session_role(s, u.id, sess, WS_ROLE_ADMIN)
    result = recording_store.secure_erase(s, session_id)
    audit_event("recording.erased", actor_user_id=u.id,
                resource_type="session", resource_id=session_id,
                details={"frame_count": result.frame_count,
                         "newly_redacted": result.newly_redacted,
                         "checkpoints_deleted": result.checkpoints_deleted})
    return {"session_id": result.session_id,
            "frame_count": result.frame_count,
            "newly_redacted": result.newly_redacted,
            "already_redacted": result.already_redacted,
            "checkpoints_deleted": result.checkpoints_deleted}


@app.patch("/api/sessions/{session_id}/retention")
async def update_session_retention(session_id: str, request: Request,
                                   s: OrmSession = Depends(db)):
    """Update a session's recording retention policy and enforce it now."""
    u = current_user(request, s)
    sess = s.get(Session, session_id)
    if not sess:
        raise HTTPException(404, "not found")
    _session_role(s, u.id, sess, WS_ROLE_ADMIN)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")
    retention = body.get("retention") if isinstance(body, dict) else None
    if retention not in models.VALID_RETENTIONS:
        raise HTTPException(422, "retention must be none, 7d, 30d, or permanent")
    redacted = recording_store.set_retention(s, sess, retention)
    audit_event("recording.retention_changed", actor_user_id=u.id,
                resource_type="session", resource_id=session_id,
                details={"retention": retention, "redacted_frames": redacted})
    return {"session_id": session_id, "retention": retention,
            "redacted_frames": redacted}


# ---------------------------------------------------------------- runtime REST (connector)
@app.get("/api/me")
async def me_devbox(request: Request, s: OrmSession = Depends(db)):
    d = devbox_from_bearer(request, s)
    return {"devbox_id": d.id, "name": d.name,
            "protocol_version": PROTOCOL_VERSION,
            "projects": [_project_json(project) for project in d.projects],
            "agents": _connector_agent_dir(list(d.agents))}


@app.post("/api/devboxes/{devbox_id}/runtimes")
async def report_runtimes(devbox_id: str, request: Request, s: OrmSession = Depends(db)):
    d = devbox_from_bearer(request, s)
    if d.id != devbox_id:
        raise HTTPException(403, "wrong devbox")
    body = await request.json()
    d.capabilities = body.get("capabilities")
    s.commit()
    return {"ok": True}


@app.post("/api/devboxes/{devbox_id}/projects")
async def report_projects(devbox_id: str, request: Request,
                          s: OrmSession = Depends(db)):
    """Replace connector-owned project metadata without receiving local paths."""
    d = devbox_from_bearer(request, s)
    if d.id != devbox_id:
        raise HTTPException(403, "wrong devbox")
    body = await request.json()
    raw_projects = body.get("projects", [])
    raw_migrations = body.get("migrations", [])
    if not isinstance(raw_projects, list) or not isinstance(raw_migrations, list):
        raise HTTPException(422, "projects and migrations must be arrays")
    if len(raw_projects) > 500 or len(raw_migrations) > 1000:
        raise HTTPException(422, "project report is too large")

    projects: dict[str, dict] = {}
    for item in raw_projects:
        if not isinstance(item, dict):
            raise HTTPException(422, "project entries must be objects")
        project_id = item.get("id")
        name = item.get("name")
        runtime_config = item.get("runtime_config") or {}
        if (not isinstance(project_id, str) or not project_id or len(project_id) > 64
                or not isinstance(name, str) or not name.strip() or len(name) > 200
                or not isinstance(runtime_config, dict)
                or len(json.dumps(runtime_config)) > 16 * 1024):
            raise HTTPException(422, "invalid project metadata")
        if any(key in item for key in ("path", "cwd", "root")):
            raise HTTPException(422, "local paths are not accepted")
        if project_id in projects:
            raise HTTPException(422, "duplicate project id")
        claimed = s.get(DevboxProject, project_id)
        if claimed is not None and claimed.devbox_id != d.id:
            raise HTTPException(422, "project id belongs to another devbox")
        projects[project_id] = {
            "name": name.strip(), "runtime_config": runtime_config}

    migrations: list[tuple[str, str]] = []
    for item in raw_migrations:
        if not isinstance(item, dict):
            raise HTTPException(422, "migration entries must be objects")
        agent_id = item.get("agent_id")
        project_id = item.get("local_project_id")
        if not isinstance(agent_id, str) or project_id not in projects:
            raise HTTPException(422, "invalid project migration")
        migrations.append((agent_id, project_id))

    existing = {project.id: project for project in s.scalars(select(
        DevboxProject).where(DevboxProject.devbox_id == d.id)).all()}
    for project_id, metadata in projects.items():
        project = existing.get(project_id)
        if project is None:
            project = DevboxProject(
                id=project_id, devbox_id=d.id,
                name=metadata["name"], runtime_config=metadata["runtime_config"])
            s.add(project)
        else:
            project.name = metadata["name"]
            project.runtime_config = metadata["runtime_config"]
    s.flush()

    agents = {agent.id: agent for agent in s.scalars(select(
        Agent).where(Agent.devbox_id == d.id)).all()}
    for agent_id, project_id in migrations:
        agent = agents.get(agent_id)
        if agent is None:
            raise HTTPException(422, "migration agent does not belong to this devbox")
        runtime_policy(agent.runtime).validate_project_migration(agent, project_id)
        agent.local_project_id = project_id
    # One release-cycle privacy bridge: after any successful authoritative report,
    # no absolute legacy cwd remains in the server database.
    for agent in agents.values():
        agent.cwd = None
        if agent.local_project_id not in projects:
            runtime_policy(agent.runtime).validate_project_removal()
            agent.local_project_id = None
    for project_id, project in existing.items():
        if project_id not in projects:
            s.delete(project)
    if d.skills is not None:
        d.skills = [
            item for item in d.skills
            if item.get("scope") == "personal"
            or item.get("project_id") in projects
        ]
    s.commit()
    await _push_agent_directory(d.id)
    return {"ok": True, "projects": len(projects),
            "migrations": len(migrations)}


_SKILL_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SKILL_TARGET_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _sanitized_skill_metadata(item: object, project_ids: set[str]) -> dict:
    if not isinstance(item, dict):
        raise HTTPException(422, "skill entries must be objects")
    skill_id = item.get("id")
    name = item.get("name")
    description = item.get("description")
    digest = item.get("digest")
    scope = item.get("scope")
    project_id = item.get("project_id")
    targets = item.get("targets")
    status = item.get("status")
    contains_scripts = item.get("contains_scripts")
    valid_digest = (isinstance(digest, str) and len(digest) == 64
                    and all(ch in "0123456789abcdef" for ch in digest))
    valid_targets = (isinstance(targets, list) and len(targets) <= 32
                     and len(set(targets)) == len(targets)
                     and all(isinstance(target, str) and len(target) <= 64
                             and _SKILL_TARGET_RE.fullmatch(target)
                             for target in targets))
    if (not isinstance(skill_id, str) or not skill_id or len(skill_id) > 64
            or not isinstance(name, str) or len(name) > 64
            or not _SKILL_NAME_RE.fullmatch(name)
            or not isinstance(description, str) or not description
            or len(description) > 1024 or not valid_digest
            or scope not in {"personal", "project"} or not valid_targets
            or status not in {"installed", "drifted", "missing"}
            or not isinstance(contains_scripts, bool)):
        raise HTTPException(422, "invalid skill metadata")
    if scope == "personal" and project_id is not None:
        raise HTTPException(422, "personal skills cannot reference a project")
    if scope == "project" and project_id not in project_ids:
        raise HTTPException(422, "skill project is not registered on this devbox")
    return {
        "id": skill_id, "name": name, "description": description,
        "digest": digest, "scope": scope, "project_id": project_id,
        "targets": targets, "status": status,
        "contains_scripts": contains_scripts,
    }


@app.post("/api/devboxes/{devbox_id}/skills")
async def report_skills(devbox_id: str, request: Request,
                        s: OrmSession = Depends(db)):
    """Replace path-free connector skill metadata."""
    d = devbox_from_bearer(request, s)
    if d.id != devbox_id:
        raise HTTPException(403, "wrong devbox")
    body = await request.json()
    raw_skills = body.get("skills", []) if isinstance(body, dict) else None
    if not isinstance(raw_skills, list):
        raise HTTPException(422, "skills must be an array")
    if len(raw_skills) > 256:
        raise HTTPException(422, "skill report is too large")
    project_ids = {project.id for project in d.projects}
    skills = [_sanitized_skill_metadata(item, project_ids) for item in raw_skills]
    identities = {(item["scope"], item["project_id"], item["name"])
                  for item in skills}
    if len(identities) != len(skills):
        raise HTTPException(422, "duplicate skill identity")
    d.skills = skills
    s.commit()
    return {"ok": True, "skills": len(skills)}


# ---------------------------------------------------------------- WS: devbox (connector)
def _connector_session(s: OrmSession, conn: DevboxConn, frame: dict) -> Session:
    """Authenticate the DB session→agent→devbox chain, never a claimed agent ID."""
    sid = frame.get("session_id")
    sess = s.get(Session, sid) if isinstance(sid, str) and sid else None
    agent = s.get(Agent, sess.agent_id) if sess else None
    if (not agent or agent.devbox_id != conn.devbox_id
            or ("agent_id" in frame and frame["agent_id"] != sess.agent_id)):
        raise HTTPException(403, "session is not owned by this connector")
    return sess


def _resolved_session_ready(s: OrmSession, conn: DevboxConn,
                             sess: Session, frame: dict) -> dict | None:
    """Accept the requested launch and enforce the authorized runtime's surface policy."""
    if not _matches_session_launch(sess, frame, adopt_legacy=True):
        return None
    if (sess.launch_id != "legacy" and
            (not isinstance(frame.get("pty_instance_id"), str) or not frame["pty_instance_id"])):
        return None
    surface = _surface_hint(frame)
    agent = s.get(Agent, sess.agent_id)
    policy = runtime_policy(agent.runtime if agent else None)
    surface = policy.session_surface(surface, error_status=400)
    if surface is not None:
        sess.surface = surface
    if sess.surface == "structured":
        lease = get_keyboard_lease(s, sess.id)
        if lease:
            s.delete(lease)
    conn.active_session_ids.add(sess.id)
    live_registry.get_or_create(sess.id).mark_resumed()
    instance = frame.get("pty_instance_id")
    if isinstance(instance, str) and instance:
        conn.session_instances[sess.id] = instance
    return {**frame, "type": "session.ready", "agent_id": sess.agent_id,
            "session_id": sess.id, "surface": sess.surface,
            "renderer": policy.renderer, "launch_id": sess.launch_id}


def _matches_session_launch(sess: Session, frame: dict, *, adopt_legacy=False) -> bool:
    token = frame.get("launch_id")
    if sess.launch_id is None and adopt_legacy and token is None:
        # Old connectors can report pre-existing live processes. New connectors
        # must echo the generation, and new history never auto-spawns either way.
        if _session_features(sess).get("session_lifecycle") != 1:
            sess.launch_id = "legacy"
    if sess.launch_id == "legacy":
        return token in (None, "legacy")
    return bool(sess.launch_id and isinstance(token, str) and token == sess.launch_id)


def _session_failure_message(code: object) -> str:
    """Public recovery guidance, never raw connector stderr or local paths."""
    return {
        "runtime_not_authenticated": "The connector's runtime authentication check reported not signed in. Check the selected provider's authentication on the connector machine, then retry explicitly; no replacement session was created.",
        "runtime_auth_probe_failed": "The connector could not check runtime authentication. Check the local runtime and provider configuration, then retry explicitly; no replacement session was created.",
        "context.not_found": "No local native-context record was found. Restore the original connector state or start a new session explicitly.",
        "context.changed": "The original runtime or local project no longer matches. Restore the original configuration or start a new session explicitly.",
        "context.runtime_mismatch": "The original runtime no longer matches. Restore the original runtime or start a new session explicitly.",
        "context.cwd_mismatch": "The original local project no longer matches. Restore the original project or start a new session explicitly.",
        "context.in_use": "This native conversation already has a writer. End that writer before resuming.",
        "context.recovery_required": "The previous writer stopped without confirmed cleanup. Check local context status and complete explicit local recovery before retrying.",
        "context.writer_unavailable": "The local native writer could not be acquired. Check the connector before retrying.",
        "configuration_changed": "The agent configuration changed while starting. Review it before retrying.",
        "start_failed": "The CLI could not be started. Check the local connector and retry explicitly; no replacement session was created.",
        "spawn_failed": "The CLI could not be started. Check its installation, authentication and local project before retrying explicitly; no replacement session was created.",
    }.get(code if isinstance(code, str) else "", "This session could not be continued. Check the local connector; no replacement session was created.")


@app.websocket("/ws/devbox")
async def ws_devbox(ws: WebSocket):
    token = ws.headers.get("authorization", "")
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    else:
        token = ""  # tokens in query strings leak into URLs/logs; never accept them
    s = models.SessionLocal()
    tok = s.scalar(select(Token).where(Token.hash == hash_token(token)))
    if not tok or tok.revoked_at is not None:
        await ws.close(code=4001)
        s.close()
        return
    d = s.get(Devbox, tok.devbox_id)
    owner = s.get(User, d.owner_user_id) if d else None
    if d is None or not owner or owner.disabled_at is not None:
        await ws.close(code=4001)
        s.close()
        return
    agent_ids = {a.id for a in d.agents}
    d.last_seen_at = now()
    for a in d.agents:
        a.presence = "online"
    s.commit()
    await ws.accept()
    conn = DevboxConn(ws=ws, devbox_id=d.id, agent_ids=agent_ids)
    await hub.add_devbox(conn, initial_frames=({
        "type": "hello", "devbox_id": d.id,
        "agent_ids": list(agent_ids),
        "protocol_version": PROTOCOL_VERSION},))
    log_event(logger, "connector.online", devbox_id=d.id,
              agent_count=len(agent_ids))

    async def send_connector(frame: dict) -> None:
        if not hub.send_devbox(conn, frame):
            raise WebSocketDisconnect(code=1011)

    try:
        # Reconcile from a fresh committed snapshot after every transport
        # connect, closing the fetch_me -> WebSocket mutation race.
        await _push_agent_directory(d.id)
        token_id = tok.id
        while True:
            frame = await _receive_ws_object(ws, send_connector)
            if not hub.is_current_devbox(conn):
                break
            if frame is None:
                continue
            s.rollback()
            s.expire_all()  # commit keeps objects; rollback may have no transaction to expire
            # Recheck revocation and disabled owners on long-lived connections.
            tok = s.get(Token, token_id)
            devbox = s.get(Devbox, conn.devbox_id)
            owner = s.get(User, devbox.owner_user_id) if devbox else None
            if (not tok or tok.revoked_at is not None or tok.devbox_id != conn.devbox_id
                    or not owner or owner.disabled_at is not None):
                await ws.close(code=4001)
                break
            t = frame.get("type")
            if t == "agent.runtime_status":
                await _accept_runtime_status(s, conn, frame)
                continue
            sid = frame.get("session_id")
            sess = None
            session_frame = t in ("output", "input_ack", "exit", "ready", "session.ready",
                                  "runtime.unavailable", "runtime_unavailable")
            session_frame = session_frame or (t == "error" and "session_id" in frame)
            session_frame = session_frame or (t == "presence" and "session_id" in frame)
            session_frame = session_frame or (t == "process_snapshot" and "sessions" not in frame)
            if session_frame:
                try:
                    sess = _connector_session(s, conn, frame)
                except HTTPException:
                    await send_connector({"type": "error", "code": "invalid_session",
                                          "message": "session is not owned by this connector"})
                    continue
                if (t in ("exit", "error", "runtime.unavailable", "runtime_unavailable")
                        and not _matches_session_launch(sess, frame)):
                    await send_connector({"type": "error", "code": "stale_launch",
                                          "message": "session launch is no longer current"})
                    continue
                instance = frame.get("pty_instance_id")
                if (t not in ("output", "ready", "session.ready", "process_snapshot")
                        and instance and conn.session_instances.get(sid, instance) != instance):
                    await send_connector({"type": "error", "code": "stale_instance",
                                          "message": "session instance is no longer current"})
                    continue
            if t == "heartbeat":
                # Liveness ping from the connector. Refresh last_seen and echo an
                # ack so the connector can measure round-trip health.
                dd = s.get(Devbox, d.id)
                if dd:
                    dd.last_seen_at = now()
                    s.commit()
                await send_connector({"type": "heartbeat_ack",
                                    "ts": now().isoformat()})
                log_event(logger, "connector.heartbeat",
                          level=_logging.DEBUG, devbox_id=d.id)
            elif t == "output":
                sid = frame.get("session_id")
                if frame.get("seq") is not None or frame.get("pty_instance_id"):
                    # Protocol v3 durable output. Two-phase so the browser sees
                    # keystroke echo without waiting on the network-disk commit:
                    #   classify (in-memory) -> live feed + browser fan-out
                    #   -> durable commit -> ACK (the durability boundary).
                    result = recording_store.classify_output(s, devbox_id=d.id,
                                                              frame=frame)
                    if result.outcome == NEW:
                        pending_row = result.frame
                        # Fan out to the browser FIRST: echo latency must not
                        # include the fsync. Feeding the live screen and
                        # broadcasting are pure in-memory / socket work.
                        ls = live_registry.get_or_create(sid)
                        if frame.get("kind") != "event":
                            # Structured (chat) frames carry a JSON canonical
                            # event in `data`, not terminal bytes; never feed
                            # them into the pyte screen. The browser demuxes on
                            # `kind` and renders a chat surface instead.
                            ls.feed_live_output(frame.get("data", ""))
                        current_output = (
                            sess.surface != "structured" or sess.launch_id == "legacy"
                            or (sid in conn.active_session_ids and
                                conn.session_instances.get(sid) == frame.get("pty_instance_id")))
                        # Old output is still committed/ACKed below; only live
                        # fan-out is fenced so an old turn.end cannot affect a
                        # newly resumed chat's pending input state.
                        if current_output:
                            await hub.to_session_humans(sid, frame)
                        # Now make it durable OFF the event loop: a synchronous
                        # SQLite commit (network disk) would otherwise stall the
                        # loop and delay the very fan-out we just enqueued. The
                        # connection processes its frames serially, so `s` is not
                        # used concurrently while this thread runs.
                        commit = await asyncio.to_thread(
                            recording_store.commit_new, s, pending_row)
                        if not hub.is_current_devbox(conn):
                            break
                        if commit.outcome == NEW:
                            await send_connector({
                                "type": "ack", "session_id": sid,
                                "pty_instance_id": frame.get("pty_instance_id"),
                                "seq": frame.get("seq")})
                            # Auto-checkpoint the live screen after durable NEW
                            # output so the replay UI can seek without full
                            # replay. Also off the loop (DB writes).
                            try:
                                from .live import serialize_screen
                                await asyncio.to_thread(
                                    recording_store.maybe_checkpoint,
                                    s, sid, frame=commit.frame,
                                    screen_fn=lambda ls=ls: serialize_screen(ls.screen),
                                    cols=getattr(ls, "cols", 80),
                                    rows=getattr(ls, "rows", 24))
                            except Exception:
                                logger.debug("checkpoint failed", exc_info=True)
                        else:
                            # Lost a durable race (DUPLICATE/CONFLICT/GAP). The
                            # frame was already shown; respond so the connector
                            # can reconcile (re-ACK / fence / resend).
                            await send_connector(output_ack_response(
                                commit, session_id=sid,
                                pty_instance_id=frame.get("pty_instance_id"),
                                seq=frame.get("seq")))
                    elif result.outcome == DUPLICATE:
                        # Already durable and identical: re-ACK, do NOT re-feed
                        # or re-broadcast.
                        await send_connector(output_ack_response(
                            result, session_id=sid,
                            pty_instance_id=frame.get("pty_instance_id"),
                            seq=frame.get("seq")))
                    elif result.outcome == GAP:
                        await send_connector(output_ack_response(
                            result, session_id=sid,
                            pty_instance_id=frame.get("pty_instance_id"),
                            seq=frame.get("seq")))
                    elif result.outcome == CONFLICT:
                        # Forked pty_instance stream: recover via fence rather
                        # than wedging the connector's single-inflight loop.
                        log_event(logger, "recording.conflict", devbox_id=d.id,
                                  session_id=sid, seq=frame.get("seq"))
                        await send_connector(output_ack_response(
                            result, session_id=sid,
                            pty_instance_id=frame.get("pty_instance_id"),
                            seq=frame.get("seq")))
                    else:  # INVALID / ownership
                        log_event(logger, "recording.invalid", devbox_id=d.id,
                                  session_id=sid, reason=result.reason)
                        # "seq below persisted frontier" -> recoverable fence;
                        # any other INVALID stays a terminal error.
                        await send_connector(output_ack_response(
                            result, session_id=sid,
                            pty_instance_id=frame.get("pty_instance_id"),
                            seq=frame.get("seq")))
                elif sid:
                    # Legacy (< v3) blind output path.
                    data = frame.get("data", "")
                    if not isinstance(data, str):
                        await send_connector({"type": "error", "code": "invalid_frame",
                                              "message": "output data must be a string"})
                        continue
                    ls = live_registry.get_or_create(sid)
                    ls.feed_output(data)          # update screen + DVR record
                    await hub.to_session_humans(sid, frame)  # live broadcast

            elif t == "input_ack":
                sid = frame.get("session_id")
                client_input_id = frame.get("client_input_id")
                if not isinstance(client_input_id, str) or not isinstance(frame.get("status"), str):
                    await send_connector({"type": "error", "code": "invalid_frame",
                                          "message": "input acknowledgement requires string id and status"})
                    continue
                try:
                    canonical_input_id = str(UUID(client_input_id))
                except (TypeError, ValueError, AttributeError):
                    continue
                if sess:
                    agent = s.get(Agent, sess.agent_id)
                    policy = runtime_policy(agent.runtime if agent else None)
                    client_input_id = policy.acknowledged_input_id(client_input_id, canonical_input_id)
                    if client_input_id is None:
                        continue
                    ls = live_registry.get(sid)
                    if ls:
                        ls.acknowledge_input(client_input_id, frame["status"])
                    frame["client_input_id"] = client_input_id
                    await hub.to_session_humans(sid, frame)
            elif t == "exit":
                sid = frame.get("session_id")
                if sid:
                    conn.active_session_ids.discard(sid)
                    ls = live_registry.get(sid)
                    if ls:
                        ls.mark_ended(frame.get("code"))
                    await hub.to_session_humans(sid, frame)
            elif t in ("ready", "session.ready", "process_snapshot") and "sessions" not in frame:
                try:
                    ready = _resolved_session_ready(s, conn, sess, frame)
                except HTTPException as exc:
                    await send_connector({"type": "error", "code": "invalid_surface",
                                          "message": exc.detail})
                    continue
                if ready is None:
                    await send_connector({"type": "error", "code": "stale_launch",
                                          "message": "session launch is no longer current"})
                    continue
                s.commit()
                await hub.to_session_humans(sess.id, ready)
                await _broadcast_collaboration(s, sess)
            elif t == "presence":
                aid = sess.agent_id if sess else frame.get("agent_id")
                agent = s.get(Agent, aid) if isinstance(aid, str) else None
                if not agent or agent.devbox_id != conn.devbox_id:
                    await send_connector({"type": "error", "code": "invalid_session",
                                          "message": "agent is not owned by this connector"})
                    continue
                state = frame.get("state", "online")
                if not isinstance(state, str):
                    await send_connector({"type": "error", "code": "invalid_frame",
                                          "message": "presence state must be a string"})
                    continue
                agent.presence = state
                s.commit()
                if sess:
                    await hub.to_session_humans(sess.id, frame)
            elif t == "error" and sess:
                code = frame.get("code")
                if code not in ("runtime_not_authenticated", "runtime_auth_probe_failed",
                                "start_failed", "spawn_failed", "configuration_changed", "context.not_found",
                                "context.changed", "context.in_use", "context.recovery_required",
                                "context.writer_unavailable", "context.runtime_mismatch", "context.cwd_mismatch"):
                    code = "session_failed"
                await hub.to_session_humans(sid, {
                    "type": "error", "session_id": sid, "launch_id": sess.launch_id,
                    "code": code, "message": _session_failure_message(code)})
            elif t in ("runtime.unavailable", "runtime_unavailable"):
                sid = frame.get("session_id")
                if sid:
                    await hub.to_session_humans(sid, {
                        "type": "runtime.unavailable",
                        "session_id": sid,
                        "code": frame.get("code", "runtime_unavailable"),
                        "message": _session_failure_message(frame.get("code", "runtime_unavailable")),
                        "launch_id": sess.launch_id,
                        "runtime": frame.get("runtime"),
                        "surface": frame.get("surface"),
                        "installation": frame.get("installation"),
                        "compatibility": frame.get("compatibility"),
                        "authentication": frame.get("authentication"),
                        "available_surfaces": frame.get("available_surfaces"),
                    })
            elif t in ("sessions", "process_snapshot"):
                items = frame.get("sessions")
                if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                    await send_connector({"type": "error", "code": "invalid_frame",
                                          "message": "sessions must be a list of objects"})
                    continue
                # Validate the entire snapshot before changing any live/DB state.
                resolved = []
                seen_sessions = set()
                try:
                    for item in items:
                        sess = _connector_session(s, conn, item)
                        if sess.id in seen_sessions:
                            raise HTTPException(403, "duplicate session in snapshot")
                        seen_sessions.add(sess.id)
                        if "agent_id" in frame and frame["agent_id"] != sess.agent_id:
                            raise HTTPException(403, "session is not owned by this connector")
                        _surface_hint(item)
                        resolved.append((sess, item))
                except HTTPException as exc:
                    await send_connector({"type": "error",
                                          "code": "invalid_surface" if exc.status_code == 400 else "invalid_session",
                                          "message": exc.detail})
                    continue
                previous_active = set(conn.active_session_ids)
                previous_instances = dict(conn.session_instances)
                conn.active_session_ids.clear()
                conn.session_instances.clear()
                ready_frames = [(sess, _resolved_session_ready(s, conn, sess, item))
                                for sess, item in resolved]
                s.commit()
                for sess, ready in ready_frames:
                    if ready is None:
                        # An explicitly stale entry is not evidence that a newer
                        # accepted instance disappeared. Do not let replayed
                        # snapshots downgrade a current live generation.
                        if sess.id in previous_active:
                            conn.active_session_ids.add(sess.id)
                            conn.session_instances[sess.id] = previous_instances.get(sess.id)
                        continue
                    await hub.to_session_humans(sess.id, ready)
                    await _broadcast_collaboration(s, sess)
            elif t == "runtimes":
                d2 = s.get(Devbox, d.id)
                d2.capabilities = frame.get("capabilities")
                s.commit()
            else:
                await send_connector({"type": "error", "code": "invalid_frame",
                                      "message": "unknown command type"})
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        try:
            removed = await hub.remove_devbox(conn.devbox_id, expected=conn)
            if removed:
                log_event(logger, "connector.offline", devbox_id=conn.devbox_id)
                # HTTP reconciliation may have created/deleted agents while we
                # awaited a frame. Never flush the connection's cached d.agents:
                # deleted identities cause StaleDataError and new ones are missed.
                # Discard any interrupted frame transaction, then update only
                # currently persisted agents without touching runtime readiness.
                s.rollback()
                s.execute(update(Agent).where(Agent.devbox_id == conn.devbox_id)
                          .values(presence="offline")
                          .execution_options(synchronize_session=False))
                s.commit()
        finally:
            s.close()


async def _receive_ws_object(ws: WebSocket, send) -> dict | None:
    """Reject malformed frames without echoing auth material or user payloads."""
    try:
        frame = await ws.receive_json()
    except (ValueError, TypeError, KeyError):
        frame = None
    if not isinstance(frame, dict) or not isinstance(frame.get("type"), str):
        await send({"type": "error", "code": "invalid_frame",
                    "message": "expected a JSON object with a string type"})
        return None
    return frame


def _attached_session(s: OrmSession, conn: HumanConn, frame: dict,
                      minimum: str = WS_ROLE_OPERATOR) -> tuple[Session, str]:
    sid = frame.get("session_id")
    agent_id = conn.sessions.get(sid) if isinstance(sid, str) else None
    sess = s.get(Session, sid) if agent_id else None
    if (not sess or sess.agent_id != agent_id
            or ("agent_id" in frame and frame["agent_id"] != agent_id)):
        raise HTTPException(403, "session is not attached to this agent")
    return sess, _session_role(s, conn.user_id, sess, minimum)


def _change_keyboard(s: OrmSession, sess: Session, user_id: str, role: str,
                     action: str, target_user_id: str | None = None) -> None:
    """Shared REST/WS lease mutations; callers authorize the current operator."""
    _require_terminal_keyboard(sess)
    details = None
    if action == "acquire":
        acquire_keyboard_lease(s, sess.id, user_id, role)
        event = "keyboard.acquired"
        details = {"reason": "requested"}
    elif action == "renew":
        renew_keyboard_lease(s, sess.id, user_id)
        event = None
    elif action == "release":
        event = "keyboard.released" if release_keyboard_lease(s, sess.id, user_id) else None
    elif action == "handoff":
        if not isinstance(target_user_id, str) or not target_user_id:
            raise HTTPException(400, "target_user_id is required")
        target_role = _session_role(s, target_user_id, sess, WS_ROLE_OPERATOR)
        handoff_keyboard_lease(s, sess.id, user_id, target_user_id, target_role)
        event = "keyboard.handed_off"
        details = {"from_user_id": user_id, "to_user_id": target_user_id}
    else:
        raise HTTPException(400, "unknown keyboard action")
    s.commit()
    if event:
        audit_event(event, actor_user_id=user_id, resource_type="session",
                    resource_id=sess.id, details=details)


async def _forward_session_command(s: OrmSession, conn: HumanConn, frame: dict) -> None:
    """Current permissions, surface lease and launch generation precede every effect."""
    ws = conn.ws
    try:
        sess, _ = _attached_session(s, conn, frame)
    except HTTPException:
        message = "session control requires current operator access and attachment"
        rejection = {"type": "error", "code": "read_only", "message": message}
        if frame["type"] in ("stdin", "input"):
            # An attached viewer may know the runtime, but removed members,
            # unattached callers and mismatched agents must learn nothing new.
            try:
                sess, _ = _attached_session(s, conn, frame, WS_ROLE_VIEWER)
            except HTTPException:
                pass
            else:
                agent = s.get(Agent, sess.agent_id)
                policy = runtime_policy(agent.runtime if agent else None)
                rejection = policy.input_rejection(sess, frame, "read_only", message)
        await ws.send_json(rejection)
        return
    sid, agent_id, kind = sess.id, sess.agent_id, frame["type"]
    agent = s.get(Agent, agent_id)
    policy = runtime_policy(agent.runtime if agent else None)
    rejection = policy.command_rejection(kind)
    if rejection is not None:
        await ws.send_json(rejection)
        return
    if (sess.launch_id not in (None, "legacy") and frame.get("launch_id") != sess.launch_id):
        await ws.send_json({"type": "error", "session_id": sid, "code": "session_changed",
                            "message": "This session changed. Reattach before sending commands."})
        return
    if (sess.launch_id not in (None, "legacy") and kind != "terminate"
            and not hub.is_session_active(agent_id, sid)):
        await ws.send_json({"type": "error", "session_id": sid, "code": "resume_required",
                            "message": "The session is not ready. Use explicit Resume."})
        return
    if sess.surface == "structured" and kind == "resize":
        await ws.send_json({"type": "error", "code": "surface_not_supported",
                            "message": "structured sessions do not use terminal resize"})
        return
    if sess.surface != "structured":
        lease = get_keyboard_lease(s, sid)
        if not lease or lease.holder_user_id != conn.user_id or lease_is_expired(lease, now()):
            await ws.send_json({"type": "error", "code": "keyboard_lease_required",
                                "message": "request keyboard control before sending input or control"})
            await _broadcast_collaboration(s, sess)
            return
    outbound = {**frame, "agent_id": agent_id}
    ls = live_registry.get(sid)
    if kind in ("stdin", "input"):
        try:
            client_input_id, data = policy.prepare_input(sess, frame)
        except InputRejected as exc:
            await ws.send_json(exc.frame)
            return
        if ls:
            ls.queue_input(client_input_id, data)
        outbound.update(client_input_id=client_input_id, data=data)
    elif kind == "resize":
        cols, rows = frame.get("cols", 120), frame.get("rows", 30)
        if any(type(value) is not int or not 1 <= value <= 1000 for value in (cols, rows)):
            await ws.send_json({"type": "error", "message": "invalid terminal dimensions"})
            return
        if ls:
            ls.resize(cols, rows)
        outbound.update(cols=cols, rows=rows)
    elif kind == "terminate":
        previous = sess.launch_id
        ended_launch = new_id()
        changed = s.execute(update(Session).where(
            Session.id == sid, Session.launch_id == previous).values(launch_id=ended_launch))
        if changed.rowcount != 1:
            s.rollback()
            await ws.send_json({"type": "error", "session_id": sid, "code": "session_changed",
                                "message": "The session changed. Reattach before ending it."})
            return
        s.commit()
        # Target the old run. A delayed terminate must not kill a later resume.
        outbound = {"type": "terminate", "agent_id": agent_id, "session_id": sid,
                    "launch_id": None if previous == "legacy" else previous}
    ok = await hub.to_devbox(agent_id, outbound)
    if not ok:
        if kind == "terminate":
            s.execute(update(Session).where(
                Session.id == sid, Session.launch_id == ended_launch).values(launch_id=previous))
            s.commit()
        await ws.send_json({"type": "error", "session_id": sid, "code": "agent_offline",
                            "message": "The machine could not accept this command."})
    elif kind == "terminate":
        owner = hub.devboxes.get(hub.agent_to_devbox.get(agent_id, ""))
        if owner:
            owner.active_session_ids.discard(sid)
        if ls:
            ls.mark_ended(None)
        audit_event("session.terminated", actor_user_id=conn.user_id,
                    resource_type="session", resource_id=sid)
        await hub.to_session_humans(sid, {"type": "status", "session_id": sid,
                                        "state": "ended", "launch_id": ended_launch})


async def _broadcast_collaboration(s: OrmSession, sess: Session) -> None:
    for watcher in list(hub.session_watchers.get(sess.id, set())):
        try:
            role = _session_role(s, watcher.user_id, sess)
        except HTTPException:
            hub.unwatch(watcher, sess.id)
            continue
        try:
            await watcher.ws.send_json(_lease_json(s, sess, watcher.user_id, role))
        except Exception:
            pass


# ---------------------------------------------------------------- WS: human (terminal)
@app.websocket("/ws/term")
async def ws_term(ws: WebSocket):
    # Browser cookies authenticate this socket, so reject cross-origin WS
    # attempts before reading the session cookie.
    if not settings.origin_allowed(ws.headers.get("origin")):
        await ws.close(code=4003)
        return
    cookie = ws.cookies.get("deepbox_session")
    try:
        uid = signer.loads(
            cookie, max_age=settings.session_ttl_seconds)["uid"] if cookie else None
    except BadSignature:
        uid = None
    if not uid:
        await ws.close(code=4001)
        return
    _u = models.SessionLocal()
    try:
        _user = _u.get(User, uid)
        if not _user or _user.disabled_at is not None:
            await ws.close(code=4001)
            return
    finally:
        _u.close()
    await ws.accept()
    conn = HumanConn(ws=ws, user_id=uid)
    hub.add_human(conn)
    s = models.SessionLocal()
    try:
        while True:
            frame = await _receive_ws_object(ws, ws.send_json)
            if frame is None:
                continue
            # A long-lived socket must re-read current user, membership and
            # session rows rather than authorize from its identity-map cache.
            s.rollback()
            s.expire_all()
            user = s.get(User, uid, populate_existing=True)
            if not user or user.disabled_at is not None:
                await ws.send_json({"type": "error", "code": "read_only",
                                    "message": "user is disabled or unavailable"})
                await ws.close(code=4001)
                break
            t = frame.get("type")
            if t in ("attach", "open", "resume"):  # 'open' is legacy attach, not a resume bypass
                sid = frame.get("session_id")
                sess = s.get(Session, sid) if isinstance(sid, str) else None
                try:
                    role = _session_role(s, uid, sess) if sess else None
                except HTTPException:
                    role = None
                if not sess or not role:
                    await ws.send_json({"type": "error", "message": "no such session"})
                    continue
                if "agent_id" in frame and frame["agent_id"] != sess.agent_id:
                    await ws.send_json({"type": "error", "message": "session does not belong to agent"})
                    continue
                agent = s.get(Agent, sess.agent_id)
                policy = runtime_policy(agent.runtime if agent else None)
                sess.surface = policy.stored_surface(sess.surface)
                try:
                    requested_surface = _surface_hint(frame)
                except HTTPException as exc:
                    await ws.send_json({"type": "error", "code": "invalid_surface",
                                        "message": exc.detail})
                    continue
                if sess.surface and requested_surface and requested_surface != sess.surface:
                    await ws.send_json({"type": "error", "code": "surface_mismatch",
                                        "message": "requested surface does not match the stored session surface",
                                        "surface": sess.surface})
                    continue
                surface = sess.surface or requested_surface
                cols, rows = frame.get("cols", 120), frame.get("rows", 30)
                if any(type(value) is not int or not 1 <= value <= 1000 for value in (cols, rows)):
                    await ws.send_json({"type": "error", "message": "invalid terminal dimensions"})
                    continue
                if t == "resume":
                    if not can_control(role):
                        await ws.send_json({"type": "error", "session_id": sid,
                                            "code": "read_only", "message": "Operator access is required to resume."})
                        continue
                    if not _native_resume_supported(sess):
                        await ws.send_json({"type": "runtime.unavailable", "session_id": sid,
                                            "code": "resume_unsupported", "message":
                                            "This session does not report explicit native resume support. "
                                            "Update the connector; no new session was created."})
                        continue
                    if "launch_id" not in frame or frame["launch_id"] != sess.launch_id:
                        await ws.send_json({"type": "error", "session_id": sid,
                                            "code": "session_changed", "message":
                                            "This session changed. Refresh its history before resuming."})
                        continue
                participant = s.scalar(select(SessionParticipant).where(
                    SessionParticipant.session_id == sess.id,
                    SessionParticipant.user_id == uid))
                if participant:
                    participant.last_seen_at = now()
                    participant.role = role
                else:
                    s.add(SessionParticipant(id=new_id(), session_id=sess.id,
                                             user_id=uid, role=role))
                lease = get_keyboard_lease(s, sess.id)
                if (sess.surface != "structured" and can_control(role)
                        and (not lease or lease_is_expired(lease, now()))):
                    acquire_keyboard_lease(s, sess.id, uid, role)
                    audit_event("keyboard.acquired", actor_user_id=uid,
                                resource_type="session", resource_id=sess.id,
                                details={"reason": "initial_attach"})
                s.commit()
                # ensure a LiveSession exists (rebuilds screen from .cast if server restarted)
                ls = live_registry.get_or_create(sess.id, cols, rows)
                hub.watch(conn, sess.id, sess.agent_id)
                await _broadcast_collaboration(s, sess)
                # 1) Restore terminal pixels or the structured event timeline.
                event_data = live_registry.event_restore(sess.id)
                if event_data or policy.restore_events:
                    await ws.send_json({"type": "restore", "session_id": sess.id,
                                        "kind": "event", "data": event_data or ""})
                else:
                    await ws.send_json({"type": "restore", "session_id": sess.id,
                                        "data": ls.restore_bytes()})
                # Attach/reload never resurrects a historical session. A live
                # process is reattached without even queuing an open command.
                if hub.is_session_active(sess.agent_id, sess.id):
                    await ws.send_json({"type": "status", "session_id": sess.id,
                                        "state": "live", "surface": sess.surface,
                                        "renderer": policy.renderer,
                                        "runtime_status": agent.runtime_status if agent else None,
                                        "launch_id": sess.launch_id, "reattached": t == "resume"})
                    continue
                initial = sess.launch_id is None and not ls.ended
                if t != "resume" and not (initial and can_control(role)):
                    await ws.send_json({"type": "status", "session_id": sess.id,
                                        "state": "ended" if ls.ended else "inactive",
                                        "surface": sess.surface, "launch_id": sess.launch_id,
                                        "renderer": policy.renderer,
                                        "runtime_status": agent.runtime_status if agent else None,
                                        "code": "resume_required", "message":
                                        "History is read-only. Use Resume to continue the original conversation."})
                    continue
                if not hub.is_agent_online(sess.agent_id):
                    await ws.send_json({"type": "status", "session_id": sess.id,
                                        "state": "offline", "surface": sess.surface,
                                        "renderer": policy.renderer,
                                        "runtime_status": agent.runtime_status if agent else None,
                                        "launch_id": sess.launch_id})
                    continue
                previous = sess.launch_id
                launch = new_id() if _session_features(sess).get("session_lifecycle") == 1 else "legacy"
                changed = s.execute(update(Session).where(
                    Session.id == sess.id, Session.launch_id == previous).values(launch_id=launch))
                if changed.rowcount != 1:
                    s.rollback()
                    await ws.send_json({"type": "error", "session_id": sid,
                                        "code": "session_changed", "message":
                                        "This session changed. Refresh its history before resuming."})
                    continue
                s.commit()
                # Set preparing BEFORE enqueuing so an immediate ready cannot
                # be overwritten by a late 'starting' status.
                # Pending resume is not idle history: preserve the Agent policy's
                # configuration-update guard while awaiting Connector readiness.
                was_ended, previous_exit_code = ls.ended, ls.exit_code
                ls.mark_resumed()
                await ws.send_json({"type": "status", "session_id": sess.id,
                                    "state": "starting", "surface": sess.surface,
                                    "launch_id": launch,
                                    "renderer": policy.renderer,
                                    "runtime_status": agent.runtime_status if agent else None})
                # Sending status yielded to other sockets (End/role changes).
                # Recheck the same durable token before the non-yielding enqueue.
                s.rollback()
                sess = s.get(Session, sid, populate_existing=True)
                if not sess or sess.launch_id != launch:
                    await ws.send_json({"type": "error", "session_id": sid,
                                        "code": "session_changed", "message": "The session changed before startup."})
                    continue
                try:
                    fresh_user = s.get(User, uid, populate_existing=True)
                    if not fresh_user or fresh_user.disabled_at is not None:
                        raise HTTPException(403, "access changed")
                    _session_role(s, uid, sess, WS_ROLE_OPERATOR)
                except HTTPException:
                    s.execute(update(Session).where(
                        Session.id == sid, Session.launch_id == launch).values(launch_id=previous))
                    s.commit()
                    if was_ended:
                        ls.mark_ended(previous_exit_code)
                    await ws.send_json({"type": "error", "session_id": sid,
                                        "code": "read_only", "message": "Operator access is required to start or resume."})
                    continue
                ok = await hub.to_devbox(sess.agent_id, {
                    # Never forward browser profile/config/credential overrides.
                    # Desired settings enter only via the authorized Agent policy.
                    "type": "resume" if t == "resume" and not policy.library_continuation else "open",
                    "agent_id": sess.agent_id, "session_id": sess.id,
                    "launch_id": launch, "cols": cols, "rows": rows, "surface": surface})
                if not ok:
                    s.execute(update(Session).where(
                        Session.id == sess.id, Session.launch_id == launch).values(launch_id=previous))
                    s.commit()
                    if was_ended:
                        ls.mark_ended(previous_exit_code)
                    await ws.send_json({"type": "status", "session_id": sess.id,
                                        "state": "offline", "surface": sess.surface,
                                        "renderer": policy.renderer,
                                        "runtime_status": agent.runtime_status if agent else None,
                                        "launch_id": sess.launch_id,
                                        "message": "The machine could not accept the request. No process was started."})
            elif t in ("keyboard_acquire", "keyboard_renew", "keyboard_release", "keyboard_handoff"):
                sid = frame.get("session_id")
                try:
                    sess, role = _attached_session(s, conn, frame)
                    _change_keyboard(s, sess, uid, role, t.removeprefix("keyboard_"),
                                     frame.get("target_user_id"))
                    await _broadcast_collaboration(s, sess)
                except (HTTPException, PermissionDenied, LeaseError) as exc:
                    s.rollback()
                    if isinstance(exc, LeaseConflict):
                        requester = s.get(User, uid)
                        await hub.to_session_humans(sid, {
                            "type": "keyboard_request", "session_id": sid,
                            "requester_user_id": uid,
                            "requester_username": requester.username if requester else "collaborator",
                        })
                        audit_event("keyboard.requested", actor_user_id=uid,
                                    resource_type="session", resource_id=sid)
                    code = "keyboard_busy" if t == "keyboard_acquire" else f"{t}_failed"
                    if isinstance(exc, HTTPException) and exc.status_code == 400:
                        code = "keyboard_not_supported"
                    await ws.send_json({"type": "error", "code": code,
                                        "message": str(getattr(exc, "detail", exc))})
            elif t in ("stdin", "input", "permission", "interrupt", "resize", "terminate"):
                await _forward_session_command(s, conn, frame)
            elif t in ("detach", "close"):  # viewer leaves; PTY keeps running
                sid = frame.get("session_id")
                if isinstance(sid, str):
                    hub.unwatch(conn, sid)
            else:
                await ws.send_json({"type": "error", "code": "invalid_frame",
                                    "message": "unknown command type"})
    except WebSocketDisconnect:
        pass
    finally:
        hub.remove_human(conn)
        s.close()


# ---------------------------------------------------------------- static web
# Windows can register .js as text/plain; nosniff then makes the SPA unbootable.
mimetypes.add_type("application/javascript", ".js")
if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    f = WEB_DIR / "index.html"
    if f.exists():
        return f.read_text(encoding="utf-8")
    return f"<h1>{DISPLAY_NAME}</h1><p>web/index.html missing</p>"
