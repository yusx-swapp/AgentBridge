(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  // Keep the old global only at this boundary for cached clients during rollout.
  if(root) root.AgentBridgeUI = root.DeepboxUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  // ---- text helpers ------------------------------------------------------

  // HTML-escape for safe interpolation of any server-provided string.
  function escapeHtml(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }

  function apiErrorMessage(status, statusText, body){
    const text = String(body == null ? '' : body).trim();
    if(text){
      try {
        const parsed = JSON.parse(text);
        if(typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim();
        if(typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
      } catch(_error) {
        // Preserve plain-text server errors verbatim.
      }
      return text;
    }
    const label = [status, String(statusText || '').trim()].filter(Boolean).join(' ');
    return label ? `Request failed (${label})` : 'Request failed';
  }

  // Short label for an avatar/monogram from a display name or handle.
  function initials(name){
    const cleaned = String(name == null ? '' : name).trim();
    if(!cleaned) return '?';
    const words = cleaned.replace(/^[@#]+/, '').split(/[\s._-]+/).filter(Boolean);
    if(words.length === 0) return '?';
    if(words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  // Runtime IDs are adapter-owned and intentionally opaque to the web app. A new
  // connector adapter must remain usable without a frontend change, so the UI
  // displays the reported identifier rather than maintaining a runtime registry.
  function runtimeLabel(runtime){
    const value = String(runtime == null ? '' : runtime).trim();
    return value || 'runtime';
  }

  // Capability reports started as a bare runtime array. Newer connectors wrap
  // that array so sanitized local inventories can travel beside it while the
  // server continues treating the payload as opaque JSON.
  function runtimeCapabilities(report){
    if(Array.isArray(report)) return report;
    return Array.isArray(report?.runtimes) ? report.runtimes : [];
  }

  function skillInventory(report){
    const items = Array.isArray(report?.skills) ? report.skills : [];
    return items.filter(item=>item && item.name).map(item=>({
      name:String(item.name),
      description:String(item.description || ''),
      digest:String(item.digest || ''),
      scope:item.scope === 'project' ? 'project' : 'personal',
      project_id:item.project_id ? String(item.project_id) : null,
      targets:Array.isArray(item.targets) ? item.targets.map(String) : [],
      status:['installed', 'drifted', 'missing'].includes(item.status)
        ? item.status : 'unknown',
      contains_scripts:item.contains_scripts === true,
    }));
  }

  function _commandValue(value, fallback){
    const text = String(value == null ? '' : value).trim() || fallback;
    return `"${text.replace(/"/g, '\\"')}"`;
  }

  function projectAddCommand(path, name){
    return `agentbridge project add ${_commandValue(path, '<local-folder>')} --name ${_commandValue(name, '<project-name>')}`;
  }

  function skillInstallCommand(path, project){
    const base = `agentbridge skill install ${_commandValue(path, '<skill-folder>')}`;
    return project ? `${base} --project ${_commandValue(project, '<project>')}` : base;
  }

  function skillRemoveCommand(name, project){
    const base = `agentbridge skill remove ${_commandValue(name, '<skill-name>')}`;
    return project ? `${base} --project ${_commandValue(project, '<project>')}` : base;
  }

  function isCapabilityV2(capability){
    return !!(capability && Number(capability.schema_version) >= 2
      && Array.isArray(capability.surfaces));
  }

  function capabilitySurfaces(capability){
    return isCapabilityV2(capability)
      ? capability.surfaces.filter(surface=>surface && typeof surface.id === 'string') : [];
  }

  function findRuntimeCapability(capabilities, runtimeId){
    const wanted = String(runtimeId || '');
    const list = runtimeCapabilities(capabilities);
    return list.find(capability=> capability && (
      capability.runtime === wanted
      || (Array.isArray(capability.legacy_runtime_ids)
        && capability.legacy_runtime_ids.includes(wanted))
      || (Array.isArray(capability.surfaces)
        && capability.surfaces.some(surface=>surface.legacy_runtime_id === wanted))
    )) || null;
  }

  function runtimeOptions(capabilities){
    const seen = new Set();
    const out = [];
    for(const capability of runtimeCapabilities(capabilities)){
      if(!capability) continue;
      const installed = typeof capability === 'string' || (isCapabilityV2(capability)
        ? capability.installation?.status === 'installed'
        : capability.installed !== false);
      if(!installed) continue;
      const id = String(typeof capability === 'string' ? capability : capability.runtime || '').trim();
      if(!id || seen.has(id)) continue;
      seen.add(id); out.push(id);
    }
    return out;
  }

  function localProjectOptions(projects){
    const seen = new Set();
    const out = [];
    for(const project of Array.isArray(projects) ? projects : []){
      const id = String(project?.id || '').trim();
      const name = String(project?.name || '').trim();
      if(!id || !name || seen.has(id)) continue;
      seen.add(id);
      out.push({id, name});
    }
    return out;
  }

  function runtimeInventory(capabilities){
    return runtimeCapabilities(capabilities).filter(Boolean).map(capability=>{
      const v2 = isCapabilityV2(capability);
      return {
        id: String(capability.runtime || ''),
        label: String(capability.label || runtimeLabel(capability.runtime)),
        installation: v2
          ? String(capability.installation?.status || 'unknown')
          : (capability.installed === false ? 'missing' : 'installed'),
        compatibility: v2
          ? String(capability.compatibility?.status || 'unknown') : 'unknown',
        authentication: v2
          ? String(capability.authentication?.status || 'unknown') : 'unknown',
        guidance: v2 ? (capability.installation?.guidance || {}) : {},
      };
    }).filter(item=>item.id);
  }

  function preferredSurface(capability){
    if(!isCapabilityV2(capability)){
      return capability?.features?.structured ? 'structured' : 'terminal';
    }
    const surfaces = capability.surfaces;
    const selected = surfaces.find(surface=>surface.default)
      || surfaces.find(surface=>surface.id === 'structured') || surfaces[0];
    return selected ? selected.id : null;
  }

  function capabilityForSurface(capability, surfaceId){
    if(!isCapabilityV2(capability)) return capability;
    const selectedId = surfaceId || preferredSurface(capability);
    const surface = capability.surfaces.find(item=>item.id === selectedId);
    if(!surface) return null;
    const features = {...(surface.features || {}), structured:selectedId === 'structured'};
    const modelContract = capability.models || {};
    const surfaceModelIds = Array.isArray(features.models)
      ? features.models.map(item=>typeof item === 'string' ? item : item?.id).filter(Boolean) : [];
    const modelIds = Array.isArray(modelContract.items)
      ? modelContract.items.map(item=>typeof item === 'string' ? item : item?.id).filter(Boolean) : [];
    features.controls = (Array.isArray(features.controls) ? features.controls : []).map(control=>{
      if(control?.key !== 'model') return control;
      const controlModelIds = Array.isArray(control.choices)
        ? control.choices.map(item=>typeof item === 'string' ? item : item?.id).filter(Boolean) : [];
      return {
        ...control,
        choices:controlModelIds.length ? controlModelIds
          : (surfaceModelIds.length ? surfaceModelIds : modelIds),
        allow_custom:typeof control.allow_custom === 'boolean'
          ? control.allow_custom : !!modelContract.allow_custom,
      };
    });
    return {...capability, surface:selectedId, surface_available:!!surface.available, features};
  }

  function agentApiPath(agentId){
    return `/api/agents/${encodeURIComponent(String(agentId || ''))}`;
  }

  function launchFields(capability, values={}, surface){
    const modes = capabilityForSurface(capability, surface)?.features?.permission_modes || [];
    const choices = [...new Set([...modes, values.permission_mode].filter(Boolean))];
    return [
      {name:'permission_mode', label:'Permission mode', type:'select', value:values.permission_mode || '',
        options:[{value:'', label:'Runtime default'}, ...choices],
        helpHtml:'<small>Bypass / allow-all modes may execute commands and modify files without asking. Use only in a trusted workspace. Runtime default may also allow actions automatically.</small>'},
      {name:'extra_args', label:'Extra CLI arguments', value:values.extra_args || '',
        placeholder:'--flag value',
        helpHtml:'<small>Optional, passed directly to the CLI (not a shell). Quote values containing spaces. Do not enter secrets. Chat transport and session identity flags are reserved.</small>'},
    ];
  }

  function accountInvitationUrl(origin, token){
    const url = new URL(origin);
    if(!['http:','https:'].includes(url.protocol)) throw new TypeError('Invitation links need an HTTP origin');
    return url.origin + '/#invite=' + encodeURIComponent(String(token));
  }

  function resumableSession(sessions, surface){
    return sessions.find(session=>session.state === 'live'
      && (!surface || session.surface === surface));
  }

  // Installation and connection are separate. Install/upgrade sources always
  // use the canonical AgentBridge repository, never a development fork.
  // Fresh installs use ~/.agentbridge; existing legacy/custom roots are reused.
  const INSTALL_PS1_URL = 'https://raw.githubusercontent.com/yusx-swapp/AgentBridge/main/scripts/install.ps1';
  const INSTALL_SH_URL = 'https://raw.githubusercontent.com/yusx-swapp/AgentBridge/main/scripts/install.sh';
  function windowsInstallCommand(){
    return 'irm ' + INSTALL_PS1_URL + ' | iex';
  }
  function unixInstallCommand(){
    return 'curl -fsSL ' + INSTALL_SH_URL + ' | bash && export PATH="${AGENTBRIDGE_HOME-${DEEPBOX_HOME-$HOME/.agentbridge}}/bin:$HOME/.deepbox/bin:$PATH"';
  }
  function windowsConnectorCommand(serverUrl, token){
    const server = String(serverUrl == null ? '' : serverUrl).trim();
    const secret = String(token == null ? '' : token).trim();
    return [
      '$env:AGENTBRIDGE_SERVER_URL = "' + server + '"',
      '$env:AGENTBRIDGE_TOKEN = "' + secret + '"',
      'agentbridge connect',
    ].join('\n');
  }
  // macOS / Linux equivalent. Connecting never runs the installer.
  function unixConnectorCommand(serverUrl, token){
    const server = String(serverUrl == null ? '' : serverUrl).trim();
    const secret = String(token == null ? '' : token).trim();
    return [
      'export AGENTBRIDGE_SERVER_URL="' + server + '"',
      'export AGENTBRIDGE_TOKEN="' + secret + '"',
      'agentbridge connect',
    ].join('\n');
  }

  // ---- terminal input ----------------------------------------------------

  // Forward xterm input synchronously. A terminal is latency-sensitive: adding
  // even a short idle batching timer makes key echo feel sticky because the user
  // already pays the browser -> server -> connector -> PTY round trip. The
  // lifecycle guard prevents a sender captured by an old WebSocket from leaking
  // keystrokes after a reconnect or session switch.
  function shouldFocusTerminal(force, activeTag, terminalOwnsFocus){
    if(force || terminalOwnsFocus) return true;
    return !/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(String(activeTag || '').toUpperCase());
  }

  function createTerminalInputSender(send){
    let active = true;
    function push(data, options){
      const chunk = String(data == null ? '' : data);
      if(!active || !chunk) return false;
      const result = options === undefined ? send(chunk) : send(chunk, options);
      return result !== false;
    }
    function close(){ active = false; }
    return {push, close};
  }

  // ---- status helpers ----------------------------------------------------

  function supportsStructuredChat(capability, surfaceId){
    if(surfaceId) return surfaceId === 'structured';
    if(isCapabilityV2(capability)){
      return (surfaceId || capability.surface || preferredSurface(capability)) === 'structured';
    }
    return !!capability?.features?.structured;
  }

  // Devbox connection state -> {state, label}. Text is never colour-only.
  function devboxStatus(devbox){
    const online = !!(devbox && devbox.online);
    return {
      state: online ? 'online' : 'offline',
      label: online ? 'Online' : 'Offline',
    };
  }

  // Agent presence -> {state, label}.
  function agentStatus(agent){
    const presence = agent && agent.presence;
    if(presence === 'online') return {state: 'online', label: 'Online'};
    if(presence === 'busy') return {state: 'busy', label: 'Busy'};
    return {state: 'offline', label: 'Offline'};
  }

  // ---- fleet aggregation -------------------------------------------------

  // Roll up a fleet into online/total counts for both devboxes and agents.
  function fleetSummary(devboxes){
    const list = Array.isArray(devboxes) ? devboxes : [];
    let devboxOnline = 0, agentTotal = 0, agentOnline = 0;
    for(const box of list){
      if(box && box.online) devboxOnline++;
      const agents = (box && Array.isArray(box.agents)) ? box.agents : [];
      for(const agent of agents){
        agentTotal++;
        if(agent && agent.presence === 'online') agentOnline++;
      }
    }
    return {
      devboxTotal: list.length,
      devboxOnline: devboxOnline,
      agentTotal: agentTotal,
      agentOnline: agentOnline,
    };
  }

  // ---- filtering ---------------------------------------------------------

  function normalize(value){
    return String(value == null ? '' : value).toLowerCase().trim();
  }

  function agentMatches(agent, needle){
    if(!needle) return true;
    const hay = [
      agent && agent.display_name,
      agent && agent.handle,
      agent && agent.runtime,
      runtimeLabel(agent && agent.runtime),
    ].map(normalize).join(' ');
    return hay.indexOf(needle) !== -1;
  }

  // Filter a fleet by a free-text query. A devbox is kept when its name or ID
  // matches, or when any of its agents match; matching agents are kept.
  function filterDevboxes(devboxes, query){
    const needle = normalize(query);
    const list = Array.isArray(devboxes) ? devboxes : [];
    if(!needle) return list.slice();
    const result = [];
    for(const box of list){
      const agents = (box && Array.isArray(box.agents)) ? box.agents : [];
      const boxHay = [box && box.name, box && box.id].map(normalize).join(' ');
      const boxHit = boxHay.indexOf(needle) !== -1;
      const matchedAgents = agents.filter(a => agentMatches(a, needle));
      if(boxHit){
        result.push(box);
      } else if(matchedAgents.length){
        result.push(Object.assign({}, box, {agents: matchedAgents}));
      }
    }
    return result;
  }

  // Flat list of every agent in the fleet, annotated with its devbox.
  function flattenAgents(devboxes){
    const list = Array.isArray(devboxes) ? devboxes : [];
    const out = [];
    for(const box of list){
      const agents = (box && Array.isArray(box.agents)) ? box.agents : [];
      for(const agent of agents){
        out.push(Object.assign({}, agent, {
          devbox_id: box && box.id,
          devbox_name: box && box.name,
          devbox_online: !!(box && box.online),
        }));
      }
    }
    return out;
  }

  function filterAgents(agents, query){
    const needle = normalize(query);
    const list = Array.isArray(agents) ? agents : [];
    if(!needle) return list.slice();
    return list.filter(a => agentMatches(a, needle) ||
      normalize(a && a.devbox_name).indexOf(needle) !== -1);
  }

  // ---- workspaces --------------------------------------------------------

  function selectWorkspace(workspaces, preferredId){
    const list = Array.isArray(workspaces) ? workspaces : [];
    if(!list.length) return null;
    const preferred = list.find(w => w && w.id === preferredId);
    if(preferred) return preferred;
    return list.find(w => w && w.is_personal) || list[0];
  }

  function devboxesForWorkspace(devboxes, workspaceId){
    const list = Array.isArray(devboxes) ? devboxes : [];
    return list.filter(d => d && d.workspace_id === workspaceId);
  }

  function canAdminWorkspace(role){
    return role === 'owner' || role === 'admin';
  }

  function workspaceInvitationCopy(preview){
    const data = preview || {};
    const name = String(data.workspace_name || 'workspace');
    const role = String(data.role || 'member');
    const emailHint = String(data.email_hint || 'the invited account');
    return {
      title: 'Join ' + name,
      description: 'You were invited as ' + role +
        '. Every member can access all devboxes and agents in this workspace. Invitation: ' +
        emailHint + '.',
    };
  }

  function workspaceAcceptanceCopy(result){
    const data = result || {};
    const workspace = data.workspace || {};
    const name = String(workspace.name || 'this workspace');
    const role = String(data.role || 'member');
    if(data.already_member === true){
      return {
        title: 'Already a member',
        description: 'You already have ' + role + ' access to ' + name + '.',
      };
    }
    return {
      title: 'Workspace joined',
      description: 'You now have ' + role + ' access to ' + name + '.',
    };
  }

  // ---- command palette ---------------------------------------------------

  // Build the command list from the current view model. Pure data only; the
  // caller wires the `action` ids to real handlers.
  function commandItems(context){
    context = context || {};
    const items = [];
    items.push({id: 'devbox.create', kind: 'action', title: 'Connect a machine',
      subtitle: 'Create an explicit machine connection', keywords: 'new add machine devbox'});
    if(context.isOwner){
      items.push({id: 'owner.open', kind: 'action', title: 'Account administration',
        subtitle: 'Invitations and members', keywords: 'admin invite member'});
    }
    const agents = flattenAgents(context.devboxes);
    for(const agent of agents){
      const status = agentStatus(agent);
      items.push({
        id: 'agent.open:' + agent.id,
        kind: 'agent',
        agentId: agent.id,
        title: '@' + (agent.handle || agent.display_name || agent.id),
        subtitle: (agent.devbox_name || 'machine') + ' \u00b7 ' +
          runtimeLabel(agent.runtime) + ' \u00b7 ' + status.label,
        keywords: [agent.display_name, agent.handle, agent.runtime,
          agent.devbox_name].filter(Boolean).join(' '),
      });
      items.push({
        id: 'agent.history:' + agent.id,
        kind: 'history',
        agentId: agent.id,
        title: 'History: @' + (agent.handle || agent.display_name || agent.id),
        subtitle: 'Replay recorded sessions on ' + (agent.devbox_name || 'machine'),
        keywords: ['history replay', agent.display_name, agent.handle,
          agent.devbox_name].filter(Boolean).join(' '),
      });
    }
    return items;
  }

  // Rank/filter command items by a query. Empty query keeps original order.
  function filterCommands(items, query){
    const list = Array.isArray(items) ? items : [];
    const needle = normalize(query);
    if(!needle) return list.slice();
    const scored = [];
    for(const item of list){
      const title = normalize(item.title);
      const hay = [title, normalize(item.subtitle), normalize(item.keywords)].join(' ');
      const idx = hay.indexOf(needle);
      if(idx === -1) continue;
      let score = idx;
      if(title.indexOf(needle) === 0) score -= 100;   // prefix on title wins
      else if(title.indexOf(needle) !== -1) score -= 40;
      scored.push({item: item, score: score});
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map(s => s.item);
  }

  // Clamp/rotate the active index over a list length for keyboard nav.
  function moveSelection(current, delta, length){
    if(!length) return 0;
    const next = (current + delta) % length;
    return next < 0 ? next + length : next;
  }

  return {
    escapeHtml: escapeHtml,
    apiErrorMessage: apiErrorMessage,
    initials: initials,
    runtimeLabel: runtimeLabel,
    runtimeCapabilities: runtimeCapabilities,
    skillInventory: skillInventory,
    projectAddCommand: projectAddCommand,
    skillInstallCommand: skillInstallCommand,
    skillRemoveCommand: skillRemoveCommand,
    isCapabilityV2: isCapabilityV2,
    capabilitySurfaces: capabilitySurfaces,
    findRuntimeCapability: findRuntimeCapability,
    runtimeOptions: runtimeOptions,
    localProjectOptions: localProjectOptions,
    runtimeInventory: runtimeInventory,
    preferredSurface: preferredSurface,
    capabilityForSurface: capabilityForSurface,
    agentApiPath: agentApiPath,
    accountInvitationUrl: accountInvitationUrl,
    resumableSession: resumableSession,
    windowsInstallCommand: windowsInstallCommand,
    unixInstallCommand: unixInstallCommand,
    windowsConnectorCommand: windowsConnectorCommand,
    unixConnectorCommand: unixConnectorCommand,
    shouldFocusTerminal: shouldFocusTerminal,
    supportsStructuredChat: supportsStructuredChat,
    createTerminalInputSender: createTerminalInputSender,
    devboxStatus: devboxStatus,
    agentStatus: agentStatus,
    fleetSummary: fleetSummary,
    filterDevboxes: filterDevboxes,
    flattenAgents: flattenAgents,
    filterAgents: filterAgents,
    selectWorkspace: selectWorkspace,
    devboxesForWorkspace: devboxesForWorkspace,
    canAdminWorkspace: canAdminWorkspace,
    launchFields,
    workspaceInvitationCopy: workspaceInvitationCopy,
    workspaceAcceptanceCopy: workspaceAcceptanceCopy,
    commandItems: commandItems,
    filterCommands: filterCommands,
    moveSelection: moveSelection,
  };
});
