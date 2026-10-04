/* Workspace, owner and Machine dialogs. All state belongs to this instance or a dialog. */
(function(root, factory){
  const common = typeof module === 'object' && module.exports;
  const api = factory(common ? require('./ui.js') : root.AgentBridgeUI,
    common ? require('./dialogs.js') : root.AgentBridgeDialogs,
    common ? require('./chat.js') : root.AgentBridgeChat);
  if(common) module.exports = api;
  else root.AgentBridgeManagement = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(UI, Dialogs, Chat){
  'use strict';
  const esc = UI.escapeHtml;
  const enc = value=>encodeURIComponent(String(value));
  const list = value=>Array.isArray(value) ? value : [];
  const message = error=>error?.message || 'The request failed. Please try again.';
  const roleLabel = role=>({viewer:'Viewer (read-only)', operator:'Operator (send messages)',
    admin:'Admin (manage workspace and send messages)', owner:'Owner (manage workspace and send messages)'}[role] || role);
  const roleOptions = role=>['viewer', 'operator'].concat(role === 'owner' ? ['admin'] : []);
  const optionsHtml = (options, selected)=>options.map(option=>{
    const value = typeof option === 'object' ? option.value : option;
    const label = typeof option === 'object' ? option.label : option;
    return `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');

  function createManagement(services){
    const {api, context, refresh, selectWorkspace, closeAgent, copyText} = services;
    const document = services.document || services.window?.document;
    const window = services.window || document?.defaultView;
    const location = services.location || window?.location || {};
    const dialogs = services.dialogs || Dialogs.createDialogs(document);

    // Snapshot identifiers, not mutable catalog objects. Refreshing a catalog is
    // deliberately NOT a context change; switching away and back still is one.
    function capture(){
      const ctx = context();
      return {userId:ctx.user?.id, workspaceId:ctx.workspace?.id, epoch:ctx.epoch};
    }
    function same(snapshot){
      const ctx = context();
      return !!ctx.user && ctx.user.id === snapshot.userId &&
        ctx.workspace?.id === snapshot.workspaceId && ctx.epoch === snapshot.epoch;
    }
    function live(snapshot, element){
      if(!same(snapshot)){
        if(element && dialogs.isCurrent(element)) dialogs.close();
        return false;
      }
      return !element || dialogs.isCurrent(element);
    }
    function workspace(id){
      const ctx = context();
      return ctx.workspace?.id === id ? ctx.workspace : list(ctx.workspaces).find(item=>item.id === id);
    }
    function canManage(snapshot, id=snapshot.workspaceId){
      return same(snapshot) && UI.canAdminWorkspace(workspace(id)?.role);
    }
    function machine(snapshot, id){
      if(!same(snapshot)) return null;
      return list(context().devboxes).find(item=>item.id === id && item.workspace_id === snapshot.workspaceId) || null;
    }
    function requireManager(snapshot, id=snapshot.workspaceId){
      if(!canManage(snapshot, id)) throw new Error('Your workspace role no longer permits this change.');
    }
    function requireOwner(snapshot){
      if(!same(snapshot) || context().user?.role !== 'owner') throw new Error('Only the local owner can manage users and local invitations.');
    }
    function loading(snapshot, title, desc='Loading…'){
      let element;
      const done = dialogs.modal({title, desc, actions:[{label:'Cancel', value:false}], onReady:root=>{ element = root; }});
      return {element, done};
    }
    async function reload(snapshot, element){
      if(!live(snapshot, element)) return false;
      await refresh();
      return live(snapshot, element);
    }
    async function reloadAfterMutation(snapshot, element){
      try { return await reload(snapshot, element); }
      catch(_error){
        if(live(snapshot, element)) dialogs.notice('Saved, but the catalog could not be refreshed. Refresh it before making another change.');
        return live(snapshot, element);
      }
    }
    function bindCopy(snapshot, root, button, getText, errorElement){
      if(!button) return;
      button.onclick = async()=>{
        if(button.disabled || !root.contains(button) || !live(snapshot, root)) return;
        button.disabled = true;
        if(errorElement) errorElement.textContent = '';
        try {
          await copyText(String(getText()));
          if(live(snapshot, root)) button.textContent = 'Copied';
        } catch(_error){
          if(live(snapshot, root)){
            button.textContent = 'Copy failed';
            if(errorElement) errorElement.textContent = 'Clipboard unavailable. Select and copy the text manually.';
          }
        } finally { if(live(snapshot, root)) button.disabled = false; }
      };
    }

    // Keep mutating forms open until the request succeeds. The real form API's
    // onReady hook lets us retain inputs and report failures inline, while every
    // submit and response is guarded by this exact dialog element.
    function mutationForm(snapshot, config, submit){
      return dialogs.form({...config, onReady:root=>{
        const form = root.querySelector('form');
        const button = root.querySelector('[data-submit]');
        const error = root.querySelector('[data-error]');
        const inputs = config.fields.map(field=>root.querySelector(`[data-field="${field.name}"]`));
        let busy = false;
        inputs.forEach(input=>{
          const edited = ()=>{
            if(busy) return;
            error.textContent = '';
            if(button.textContent === 'Saved') button.textContent = config.submit || 'Save';
          };
          input.addEventListener('input', edited);
          input.addEventListener('change', edited);
        });
        form.onsubmit = async event=>{
          event.preventDefault();
          if(busy || button.disabled || !live(snapshot, root)) return;
          error.textContent = '';
          const values = {};
          config.fields.forEach((field,index)=>{ values[field.name] = field.type === 'checkbox' ? inputs[index].checked
            : field.type === 'password' ? inputs[index].value : inputs[index].value.trim(); });
          const missing = config.fields.find(field=>field.required && !values[field.name]);
          if(missing){ error.textContent = missing.label + ' is required.'; return; }
          busy = true; button.disabled = true;
          const disabled = inputs.map(input=>input.disabled);
          inputs.forEach(input=>{ input.disabled = true; });
          try { await submit(values, root); }
          catch(problem){ if(live(snapshot, root)) error.textContent = message(problem); }
          finally {
            busy = false;
            if(live(snapshot, root)){
              button.disabled = false;
              inputs.forEach((input,index)=>{ input.disabled = disabled[index]; });
              config.onSettled?.(root);
            }
          }
        };
        config.onReady?.(root);
      }});
    }

    async function createWorkspace(){
      const snapshot = capture();
      if(!same(snapshot)) return;
      return mutationForm(snapshot, {
        title:'Create workspace', desc:'A workspace shares every Machine and agent with its members.',
        fields:[{name:'name', label:'Workspace name', type:'text', required:true}], submit:'Create workspace',
      }, async(values, root)=>{
        const created = await api('/api/workspaces', {method:'POST', body:JSON.stringify({name:values.name})});
        if(!live(snapshot, root)) return;
        if(!await reloadAfterMutation(snapshot, root)) return;
        dialogs.close();
        selectWorkspace(created.id);
      });
    }

    async function manageWorkspace(workspaceId){
      const snapshot = capture();
      const target = workspace(workspaceId ?? snapshot.workspaceId);
      if(!target || !same(snapshot)) return;
      const id = target.id;
      const pending = loading(snapshot, 'Workspace members');
      let members, invitations;
      try {
        [members, invitations] = await Promise.all([
          api(`/api/workspaces/${enc(id)}/members`),
          canManage(snapshot, id) ? api(`/api/workspaces/${enc(id)}/invitations`) : Promise.resolve([]),
        ]);
      } catch(error){
        if(live(snapshot, pending.element)) return dialogs.alert('Could not load workspace', message(error));
        return;
      }
      if(!live(snapshot, pending.element)) return;
      const targetRole = workspace(id)?.role;
      const canAdmin = canManage(snapshot, id);
      members = list(members); invitations = list(invitations);
      const editable = member=>canManage(snapshot, id) && member.role !== 'owner' && member.user_id !== snapshot.userId &&
        (member.role !== 'admin' || workspace(id)?.role === 'owner');
      const memberRows = members.map(member=>`<div class="workspace-member" data-member="${esc(member.user_id)}">
        <span class="avatar">${esc(UI.initials(member.display_name || member.username))}</span>
        <span class="workspace-member-name"><b>${esc(member.display_name || member.username)}</b><small>@${esc(member.username)}</small></span>
        <span class="workspace-member-role">${editable(member)
          ? `<select aria-label="Role for ${esc(member.username)}" data-member-role="${esc(member.role)}">${optionsHtml(roleOptions(targetRole).map(role=>({value:role, label:roleLabel(role)})), member.role)}</select><button type="button" class="ghost compact" data-save-member disabled>Save</button><small class="modal-err" data-member-error role="alert"></small>`
          : `<span title="${esc(roleLabel(member.role))}">${esc(member.role)}</span>`}</span>
      </div>`).join('') || '<p class="muted">No members.</p>';
      const adminHtml = canAdmin ? `<section class="workspace-manager-section"><h4>Invite someone</h4>
        <form class="workspace-invite-form" data-invite-form>
          <input data-invite-email type="email" aria-label="Invitation email" placeholder="name@example.com" required/>
          <select data-invite-role aria-label="Invitation role">${optionsHtml(roleOptions(targetRole).map(role=>({value:role, label:roleLabel(role)})), 'operator')}</select>
          <button type="submit">Create invitation</button>
        </form><p class="modal-err" data-invite-error role="alert"></p>
        <div class="workspace-invite-result" data-invite-result hidden><label>Share this one-time link</label>
          <div><input data-invite-link aria-label="Invitation link" readonly/><button type="button" class="ghost" data-invite-copy>Copy</button></div></div>
        <h4>Invitations</h4><div class="workspace-invitations" data-invitations></div></section>` : '';
      let root;
      const done = dialogs.modal({
        title:target.name,
        desc:`${roleLabel(targetRole)}. Operators can send chat messages; terminal typing also requires the shared keyboard. Viewers are read-only. Invitations never change an existing member’s role.`,
        bodyHtml:`<section class="workspace-manager-section"><h4>Members</h4><div class="workspace-members">${memberRows}</div></section>${adminHtml}`,
        actions:[{label:'Close', value:true, primary:true}],
        onReady:element=>{
          root = element;
          root.querySelector('.modal').classList.add('workspace-manager');
          root.querySelectorAll('[data-member]').forEach((row,index)=>{
            const member = {...members[index]};
            const role = row.querySelector('[data-member-role]'), save = row.querySelector('[data-save-member]');
            const error = row.querySelector('[data-member-error]');
            if(!role || !save) return;
            role.onchange = ()=>{
              if(!live(snapshot, root)) return;
              error.textContent = ''; save.textContent = 'Save';
              save.disabled = role.value === role.dataset.memberRole;
            };
            save.onclick = async()=>{
              if(save.disabled || !live(snapshot, root)) return;
              error.textContent = '';
              if(!editable(member) || !roleOptions(workspace(id)?.role).includes(role.value)){
                error.textContent = 'Your workspace role no longer permits this change.'; return;
              }
              const chosen = role.value;
              save.disabled = role.disabled = true;
              try {
                const changed = await api(`/api/workspaces/${enc(id)}/members/${enc(member.user_id)}`, {
                  method:'PATCH', body:JSON.stringify({role:chosen}),
                });
                if(!live(snapshot, root)) return;
                member.role = changed.role;
                role.value = role.dataset.memberRole = changed.role;
                save.textContent = 'Saved';
              } catch(problem){ if(live(snapshot, root)) error.textContent = message(problem); }
              finally {
                if(live(snapshot, root)){
                  role.disabled = !editable(member);
                  save.disabled = role.disabled || role.value === role.dataset.memberRole;
                }
              }
            };
          });
          if(!canAdmin) return;
          const error = root.querySelector('[data-invite-error]');
          const renderInvitations = ()=>{
            if(!live(snapshot, root)) return;
            const container = root.querySelector('[data-invitations]');
            container.innerHTML = invitations.map((invitation,index)=>{
              const state = invitation.accepted_at ? 'joined' : invitation.revoked_at ? 'revoked' : 'pending';
              return `<div class="workspace-invite-row" data-invitation-row><span><b>${esc(invitation.email)}</b><small>${esc(roleLabel(invitation.role))} · ${state}</small></span>${state === 'pending'
                ? `<button type="button" class="ghost compact" data-revoke-invitation="${index}">Revoke</button>` : ''}</div>`;
            }).join('') || '<p class="muted workspace-none">No invitations yet.</p>';
            container.querySelectorAll('[data-revoke-invitation]').forEach(button=>{
              button.onclick = async()=>{
                if(button.disabled || !live(snapshot, root)) return;
                const invitation = invitations[Number(button.dataset.revokeInvitation)];
                button.disabled = true; error.textContent = '';
                try {
                  requireManager(snapshot, id);
                  await api(`/api/workspaces/${enc(id)}/invitations/${enc(invitation.id)}`, {method:'DELETE'});
                  if(!live(snapshot, root)) return;
                  invitation.revoked_at = true;
                  renderInvitations();
                } catch(problem){ if(live(snapshot, root)){ error.textContent = message(problem); button.disabled = false; } }
              };
            });
          };
          renderInvitations();
          const form = root.querySelector('[data-invite-form]');
          const email = root.querySelector('[data-invite-email]'), role = root.querySelector('[data-invite-role]');
          const link = root.querySelector('[data-invite-link]'), copy = root.querySelector('[data-invite-copy]');
          bindCopy(snapshot, root, copy, ()=>link.value, error);
          form.onsubmit = async event=>{
            event.preventDefault();
            const submit = form.querySelector('button[type="submit"]');
            if(submit.disabled || !live(snapshot, root)) return;
            error.textContent = '';
            if(!email.value.trim()){ error.textContent = 'Invitation email is required.'; return; }
            submit.disabled = true;
            try {
              requireManager(snapshot, id);
              if(!roleOptions(workspace(id)?.role).includes(role.value)) throw new Error('Choose an available invitation role.');
              const invitation = await api(`/api/workspaces/${enc(id)}/invitations`, {method:'POST', body:JSON.stringify({email:email.value.trim(), role:role.value})});
              if(!live(snapshot, root)) return;
              link.value = String(invitation.join_url || '');
              copy.textContent = 'Copy';
              root.querySelector('[data-invite-result]').hidden = false;
              try {
                const updated = await api(`/api/workspaces/${enc(id)}/invitations`);
                if(live(snapshot, root)){ invitations = list(updated); renderInvitations(); }
              } catch(_error){ if(live(snapshot, root)) error.textContent = 'Invitation created. The invitation list could not be refreshed.'; }
            } catch(problem){ if(live(snapshot, root)) error.textContent = message(problem); }
            finally { if(live(snapshot, root)) submit.disabled = false; }
          };
        },
      });
      try { return await done; }
      finally { const link = root?.querySelector('[data-invite-link]'); if(link) link.value = ''; }
    }

    async function presentInvitation(token){
      const snapshot = capture();
      if(!token || !same(snapshot)) return;
      let secret = String(token);
      const pending = loading(snapshot, 'Workspace invitation');
      try {
        const preview = await api('/api/workspace-invitations/preview', {method:'POST', body:JSON.stringify({token:secret})});
        if(!live(snapshot, pending.element)) return;
        const copy = UI.workspaceInvitationCopy(preview);
        const accepted = await dialogs.modal({
          title:copy.title,
          desc:`You were invited as ${preview.role || 'member'}. Every member can access all Machines and agents in this workspace. Invitation: ${preview.email_hint || 'the invited account'}. Invitations do not change existing membership roles.`,
          bodyHtml:`<div class="workspace-join-note">Signed in as <b>${esc(context().user.email || context().user.username)}</b></div>`,
          actions:[{label:'Not now', value:false}, {label:'Join workspace', value:true, primary:true}],
        });
        if(!accepted || !same(snapshot)) return;
        const joining = loading(snapshot, 'Joining workspace', 'Accepting invitation…');
        try {
          const result = await api('/api/workspace-invitations/accept', {method:'POST', body:JSON.stringify({token:secret})});
          if(!live(snapshot, joining.element) || !await reloadAfterMutation(snapshot, joining.element)) return;
          const acceptance = UI.workspaceAcceptanceCopy(result);
          dialogs.close();
          const selected = selectWorkspace(result.workspace.id);
          const destination = capture();
          await selected;
          if(destination.userId === snapshot.userId && destination.workspaceId === result.workspace.id && same(destination)){
            return dialogs.alert(acceptance.title, acceptance.description);
          }
        } catch(error){
          if(live(snapshot, joining.element)) return dialogs.alert('Could not join workspace', `${message(error)} Check that you signed in with the invited Microsoft account.`);
        }
      } catch(error){
        if(live(snapshot, pending.element)) return dialogs.alert('Invitation unavailable', message(error));
      } finally { secret = ''; }
    }

    async function admin(){
      const snapshot = capture();
      if(!same(snapshot) || context().user.role !== 'owner') return;
      const pending = loading(snapshot, 'agentbridge administration');
      let invitations, users;
      try { [invitations, users] = await Promise.all([api('/api/invitations'), api('/api/users')]); }
      catch(error){ if(live(snapshot, pending.element)) return dialogs.alert('Could not load administration', message(error)); return; }
      if(!live(snapshot, pending.element) || context().user.role !== 'owner') return;
      let root, secret = '';
      const done = dialogs.modal({
        title:'agentbridge administration', desc:'Local account invitations and users. Workspace memberships are managed separately.',
        bodyHtml:`<section class="workspace-manager-section"><h4>Local invitations</h4>
          <form data-local-invite-form><div class="field"><label>Note (optional)<input data-local-note type="text"/></label></div>
            <div class="field"><label>Expires in hours<input data-local-ttl type="number" min="1" value="24"/></label></div>
            <button type="submit">Mint invite</button></form>
          <div data-local-invite-result hidden><div class="token-head"><b>Invite code — shown once</b><span class="list-action"><button type="button" class="ghost compact" data-local-copy>Copy code</button><button type="button" class="ghost compact" data-local-copy-link>Copy link</button></span></div><pre class="token" data-local-code></pre><small>Share privately. The registration link keeps its invitation in the URL fragment, not the query.</small></div>
          <div data-local-invitations></div></section>
          <section class="workspace-manager-section"><h4>Local users</h4><div data-local-users></div></section>
          <p class="modal-err" role="alert" data-admin-error></p>`,
        actions:[{label:'Close', value:true, primary:true}],
        onReady:element=>{
          root = element;
          const error = root.querySelector('[data-admin-error]');
          const renderInvitations = ()=>{
            if(!live(snapshot, root)) return;
            const container = root.querySelector('[data-local-invitations]');
            container.innerHTML = list(invitations).map((invite,index)=>`<div class="list-row"><span>${esc(invite.note || '(no note)')}</span><span class="muted">${esc(invite.status)} · expires ${esc(invite.expires_at)}</span>${invite.status === 'active' ? `<button type="button" class="ghost" data-local-revoke="${index}">Revoke</button>` : ''}</div>`).join('') || '<p class="muted">No invitations.</p>';
            container.querySelectorAll('[data-local-revoke]').forEach(button=>{
              button.onclick = ()=>action(button, async()=>{
                await api(`/api/invitations/${enc(invitations[Number(button.dataset.localRevoke)].id)}`, {method:'DELETE'});
                if(!live(snapshot, root)) return;
                const updated = await api('/api/invitations');
                if(live(snapshot, root)){ invitations = updated; renderInvitations(); }
              });
            });
          };
          const renderUsers = ()=>{
            if(!live(snapshot, root)) return;
            const container = root.querySelector('[data-local-users]');
            container.innerHTML = list(users).map((user,index)=>`<div class="list-row"><span class="avatar">${esc(UI.initials(user.display_name || user.username))}</span><b>${esc(user.display_name || user.username)}</b><span class="muted">@${esc(user.username)} · ${esc(user.role)}${user.disabled ? ' · disabled' : ''}</span>${user.role === 'member' ? `<button type="button" class="ghost" data-local-user="${index}">${user.disabled ? 'Enable' : 'Disable'}</button>` : ''}</div>`).join('') || '<p class="muted">No users.</p>';
            container.querySelectorAll('[data-local-user]').forEach(button=>{
              const user = users[Number(button.dataset.localUser)];
              button.onclick = ()=>action(button, async()=>{
                await api(`/api/users/${enc(user.id)}/${user.disabled ? 'enable' : 'disable'}`, {method:'POST'});
                if(!live(snapshot, root)) return;
                const updated = await api('/api/users');
                if(live(snapshot, root)){ users = updated; renderUsers(); }
              });
            });
          };
          async function action(button, perform){
            if(button.disabled || !live(snapshot, root)) return;
            button.disabled = true; error.textContent = '';
            try { requireOwner(snapshot); await perform(); }
            catch(problem){ if(live(snapshot, root)) error.textContent = message(problem); }
            finally { if(live(snapshot, root)) button.disabled = false; }
          }
          renderInvitations(); renderUsers();
          bindCopy(snapshot, root, root.querySelector('[data-local-copy]'), ()=>secret, error);
          bindCopy(snapshot, root, root.querySelector('[data-local-copy-link]'), ()=>secret ? UI.accountInvitationUrl(location.origin, secret) : '', error);
          const form = root.querySelector('[data-local-invite-form]');
          form.onsubmit = event=>{
            event.preventDefault();
            return action(form.querySelector('button[type="submit"]'), async()=>{
              const hours = Number(root.querySelector('[data-local-ttl]').value || 24);
              if(!Number.isFinite(hours) || hours <= 0) throw new Error('Enter a positive invitation lifetime in hours.');
              const result = await api('/api/invitations', {method:'POST', body:JSON.stringify({
                note:root.querySelector('[data-local-note]').value.trim() || undefined, ttl_hours:hours,
              })});
              if(!live(snapshot, root)) return;
              secret = String(result.token || '');
              root.querySelector('[data-local-code]').textContent = secret;
              root.querySelector('[data-local-copy]').textContent = 'Copy code';
              root.querySelector('[data-local-invite-result]').hidden = false;
              const updated = await api('/api/invitations');
              if(live(snapshot, root)){ invitations = updated; renderInvitations(); }
            });
          };
        },
      });
      try { return await done; }
      finally { secret = ''; const code = root?.querySelector('[data-local-code]'); if(code) code.textContent = ''; }
    }

    async function showToken(snapshot, token){
      if(!same(snapshot)) return;
      let secret = String(token || ''), root;
      try {
        return await dialogs.modal({
          title:'Machine token — shown once',
          desc:'Copy the connect code now and run it on your Machine. It contains a private token and will not be stored by AgentBridge in this browser.',
          bodyHtml:`<div class="field"><label>Operating system<select data-token-os aria-label="Operating system"><option value="windows">Windows · PowerShell</option><option value="unix">macOS / Linux</option></select></label></div>
            <div class="token-head"><b>Connect code</b><button type="button" class="ghost compact" data-token-copy>Copy</button></div>
            <pre class="token token-command" data-connect-code tabindex="0"></pre>
            <details class="local-action-guide"><summary>Install AgentBridge once (new Machines only)</summary><p>Run this installer yourself, then run the connect code above. Connecting again never reinstalls AgentBridge.</p>
              <pre class="token token-command" data-install-code></pre><button type="button" class="ghost compact" data-install-copy>Copy installer</button></details>
            <p class="modal-err" role="alert" data-token-error></p>`,
          actions:[{label:'Done', value:true, primary:true}],
          onReady:element=>{
            root = element;
            const os = root.querySelector('[data-token-os]'), connect = root.querySelector('[data-connect-code]');
            const install = root.querySelector('[data-install-code]'), error = root.querySelector('[data-token-error]');
            const origin = location.origin || `${location.protocol}//${location.host}`;
            const update = ()=>{
              if(!live(snapshot, root)) return;
              const unix = os.value === 'unix';
              connect.textContent = unix ? UI.unixConnectorCommand(origin, secret) : UI.windowsConnectorCommand(origin, secret);
              install.textContent = unix ? UI.unixInstallCommand() : UI.windowsInstallCommand();
              root.querySelector('[data-token-copy]').textContent = 'Copy';
              root.querySelector('[data-install-copy]').textContent = 'Copy installer';
              error.textContent = '';
            };
            os.onchange = update; update();
            bindCopy(snapshot, root, root.querySelector('[data-token-copy]'), ()=>connect.textContent, error);
            bindCopy(snapshot, root, root.querySelector('[data-install-copy]'), ()=>install.textContent, error);
          },
        });
      } finally {
        secret = '';
        root?.querySelectorAll('[data-connect-code],[data-install-code]').forEach(code=>{ code.textContent = ''; });
      }
    }

    async function createMachine(){
      const snapshot = capture();
      if(!canManage(snapshot)) return;
      return mutationForm(snapshot, {
        title:'Create Machine', desc:'Give this Machine a name, then connect agentbridge on it.',
        fields:[{name:'name', label:'Name', type:'text', value:'My Machine', required:true}], submit:'Create Machine',
      }, async(values, root)=>{
        requireManager(snapshot);
        const result = await api('/api/devboxes', {method:'POST', body:JSON.stringify({name:values.name, workspace_id:snapshot.workspaceId})});
        if(!live(snapshot, root) || !await reloadAfterMutation(snapshot, root)) return;
        return showToken(snapshot, result.token);
      });
    }

    async function rotateMachineToken(id){
      const snapshot = capture();
      if(!canManage(snapshot) || !machine(snapshot, id)) return;
      const accepted = await dialogs.confirm('Rotate Machine token?', 'Create a replacement connection token for this Machine. Copy the new connect code before closing it.', 'Rotate token');
      if(!accepted || !canManage(snapshot) || !machine(snapshot, id)) return;
      const pending = loading(snapshot, 'Rotating Machine token', 'Creating the replacement token…');
      try {
        const result = await api(`/api/devboxes/${enc(id)}/tokens`, {method:'POST'});
        if(live(snapshot, pending.element)) return showToken(snapshot, result.token);
      } catch(error){ if(live(snapshot, pending.element)) return dialogs.alert('Could not rotate Machine token', message(error)); }
    }

    async function deleteMachine(id){
      const snapshot = capture(), target = machine(snapshot, id);
      if(!canManage(snapshot) || !target) return;
      const affected = new Set(list(target.agents).map(agent=>agent.id));
      const accepted = await dialogs.confirm('Delete Machine?', `Delete ${target.name || 'this Machine'} and all of its agents? This cannot be undone.`, 'Delete Machine');
      if(!accepted || !canManage(snapshot) || !machine(snapshot, id)) return;
      list(machine(snapshot, id).agents).forEach(agent=>affected.add(agent.id));
      const pending = loading(snapshot, 'Deleting Machine', 'Removing the Machine and its agents…');
      try {
        await api(`/api/devboxes/${enc(id)}`, {method:'DELETE'});
        // Deletion really happened even if its dialog was closed in flight.
        // Detach exactly these agents, never navigate or clear other panes.
        list(machine(snapshot, id)?.agents).forEach(agent=>affected.add(agent.id));
        affected.forEach(agentId=>closeAgent(agentId));
        if(await reloadAfterMutation(snapshot, pending.element)) dialogs.close();
      } catch(error){ if(live(snapshot, pending.element)) return dialogs.alert('Could not delete Machine', message(error)); }
    }

    async function createAgent(machineId){
      const snapshot = capture();
      if(!canManage(snapshot) || !machine(snapshot, machineId)) return;
      const pending = loading(snapshot, 'Add agent', 'Refreshing runtimes and local projects…');
      try { if(!await reload(snapshot, pending.element)) return; }
      catch(error){ if(live(snapshot, pending.element)) return dialogs.alert('Could not load Machine', message(error)); return; }
      let target = machine(snapshot, machineId);
      if(!target || !canManage(snapshot)){ if(live(snapshot, pending.element)) dialogs.close(); return; }
      const runtimes = UI.runtimeOptions(target.capabilities);
      if(!runtimes.length) return dialogs.alert('No runtimes available', 'Open this Machine’s Runtimes list for installation instructions, then reconnect the Connector.');
      const contract = runtime=>Chat.runtimeContract({runtime});
      const projects = (item, runtime)=>[{value:'', label:contract(runtime).requiresRegisteredProject ? 'Select a registered local project (required)' : 'No project (runtime default)'}].concat(UI.localProjectOptions(item.projects).map(project=>({value:project.id, label:project.name})));
      const runtimeUis = new Map();
      for(const runtime of runtimes){
        const {agentUiModule, label} = contract(runtime);
        if(!agentUiModule) continue;
        try {
          const ui = await Chat.loadLocalModule(agentUiModule);
          runtimeUis.set(runtime, {ui, config:ui.agentConfiguration(UI.findRuntimeCapability(target.capabilities, runtime))});
        } catch(error){ if(live(snapshot, pending.element)) return dialogs.alert(`${label || runtime} setup unavailable`, message(error)); return; }
        if(!live(snapshot, pending.element)) return;
      }
      target = machine(snapshot, machineId);
      if(!target || !canManage(snapshot)){ if(live(snapshot, pending.element)) dialogs.close(); return; }
      const bindings = [];
      return mutationForm(snapshot, {
        title:'Add agent', desc:`Register an agent runtime on ${target.name}.`,
        fields:[
          {name:'handle', label:'Handle', type:'text', required:true},
          {name:'runtime', label:'Runtime', type:'select', options:runtimes, value:runtimes[0], required:true},
          {name:'local_project_id', label:'Local project', type:'select', options:projects(target, runtimes[0]), value:'',
            helpHtml:'<small data-project-help>Projects are connector-local. Add one below, then refresh.</small>'},
          ...UI.launchFields(UI.findRuntimeCapability(target.capabilities, runtimes[0])),
          ...Array.from(runtimeUis.values()).flatMap(({ui, config})=>ui.creationFields(config)),
        ], submit:'Add agent',
        extraHtml:`<details class="local-action-guide"><summary>Add a local project</summary><p>Run this on <b>${esc(target.name)}</b>. The folder path stays on that Machine.</p>
          <div class="local-command-fields"><label>Folder path<input data-project-path type="text"/></label><label>Display name<input data-project-name type="text"/></label></div>
          <div class="token-head"><b>Command</b><button type="button" class="ghost compact" data-project-copy>Copy command</button></div><pre class="token token-command" data-project-command></pre>
          <div class="local-action-footer"><small>After it succeeds, refresh this list. No restart is needed.</small><button type="button" class="ghost compact" data-refresh-projects>Refresh projects</button></div></details>`,
        onReady:root=>{
          const path = root.querySelector('[data-project-path]'), name = root.querySelector('[data-project-name]');
          const command = root.querySelector('[data-project-command]'), error = root.querySelector('[data-error]');
          const runtime = root.querySelector('[data-field="runtime"]');
          const project = root.querySelector('[data-field="local_project_id"]');
          const updateProjects = ()=>{
            const {requiresRegisteredProject, label} = contract(runtime.value);
            const required = !!requiresRegisteredProject, selected = project.value;
            const options = projects(target, runtime.value);
            const value = options.some(item=>item.value === selected) ? selected : '';
            project.innerHTML = optionsHtml(options, value); project.value = value;
            project.required = required;
            project.setAttribute('aria-required', String(required));
            root.querySelector('[data-project-help]').textContent = required
              ? (options.length > 1 ? `${label || runtime.value} requires a registered local project. Select one above.`
                : `${label || runtime.value} requires a registered local project. Add one on this Machine using the command below, then refresh projects.`)
              : 'Projects are connector-local. Optional for this runtime; add one below, then refresh.';
          };
          runtime.addEventListener('change', updateProjects); updateProjects();
          const updateLaunch = ()=>{
            const managed = runtimeUis.has(runtime.value);
            const fields = UI.launchFields(UI.findRuntimeCapability(target.capabilities, runtime.value));
            for(const field of fields){
              const input = root.querySelector(`[data-field="${field.name}"]`);
              input.closest('.field').hidden = managed; input.disabled = managed;
              input.value = '';
              if(field.options) input.innerHTML = optionsHtml(field.options, '');
            }
          };
          runtime.addEventListener('change', updateLaunch); updateLaunch();
          for(const [id, {ui, config}] of runtimeUis) bindings.push(ui.bindCreation(root, runtime, config, id,
            ()=>UI.findRuntimeCapability(target.capabilities, id)));
          const update = ()=>{ if(live(snapshot, root)) command.textContent = UI.projectAddCommand(path.value, name.value); };
          path.oninput = name.oninput = update; update();
          bindCopy(snapshot, root, root.querySelector('[data-project-copy]'), ()=>command.textContent, error);
          const button = root.querySelector('[data-refresh-projects]'), submit = root.querySelector('[data-submit]');
          button.onclick = async()=>{
            if(button.disabled || submit.disabled || !live(snapshot, root)) return;
            button.disabled = submit.disabled = true; error.textContent = '';
            try {
              if(!await reload(snapshot, root)) return;
              target = machine(snapshot, machineId);
              if(!target) throw new Error('This Machine is no longer available.');
              updateProjects();
              bindings.forEach(binding=>binding?.update?.());
            } catch(problem){ if(live(snapshot, root)) error.textContent = message(problem); }
            finally { if(live(snapshot, root)) button.disabled = submit.disabled = false; }
          };
        },
        onSettled:()=>bindings.forEach(binding=>binding?.update?.()),
      }, async(values, root)=>{
        requireManager(snapshot);
        const current = machine(snapshot, machineId);
        if(!current) throw new Error('This Machine is no longer available.');
        if(!UI.runtimeOptions(current.capabilities).includes(values.runtime)) throw new Error('This runtime is no longer available. Reconnect the Machine and reopen this dialog.');
        const selectedContract = contract(values.runtime);
        if(selectedContract.requiresRegisteredProject && !values.local_project_id) throw new Error(`${selectedContract.label || values.runtime} requires a registered local project. Add one on this Machine, refresh projects, then select it.`);
        if(!projects(current, values.runtime).some(project=>project.value === values.local_project_id)) throw new Error('This project is no longer available. Refresh projects and choose again.');
        const runtimeUi = runtimeUis.get(values.runtime)?.ui;
        const runtimeConfig = runtimeUi ? await runtimeUi.creationConfigFromValues(UI.findRuntimeCapability(current.capabilities, values.runtime), values)
          : {...(values.permission_mode ? {permission_mode:values.permission_mode} : {}),
             ...(values.extra_args ? {extra_args:values.extra_args} : {})};
        if(!live(snapshot, root)) return;
        // Runtime-owned preparation may await credential encryption. Permission
        // must still be current after that yield, not just when Save was clicked.
        requireManager(snapshot);
        const created = await api(`/api/devboxes/${enc(machineId)}/agents`, {method:'POST', body:JSON.stringify({
          handle:values.handle, display_name:values.handle, runtime:values.runtime,
          local_project_id:values.local_project_id || null, runtime_config:runtimeConfig,
        })});
        runtimeUi?.afterSave?.(root, created);
        if(await reloadAfterMutation(snapshot, root)){
          dialogs.close();
          if(runtimeUi && canManage(snapshot)) return agentSettings(created?.id);
        }
      });
    }

    // The shell asks the runtime contract, not a hardcoded runtime name.
    const hasAgentSettings = agent=>!!agent?.runtime;

    async function agentSettings(id){
      const snapshot = capture();
      const find = ()=>{
        if(!canManage(snapshot)) return null;
        for(const box of list(context().devboxes)){
          if(box.workspace_id !== snapshot.workspaceId) continue;
          const agent = list(box.agents).find(item=>item.id === id && hasAgentSettings(item));
          if(agent) return {box, agent};
        }
        return null;
      };
      const initial = find();
      if(!initial) return;
      const runtime = initial.agent.runtime;
      const settingsModule = Chat.runtimeContract(initial.agent).agentUiModule;
      const pending = loading(snapshot, 'Agent settings', 'Refreshing Agent state…');
      try { if(!await reload(snapshot, pending.element)) return; }
      catch(error){
        if(!live(snapshot, pending.element)) return;
        if(!find()){ dialogs.close(); return; }
        return dialogs.alert('Could not load Agent settings', message(error));
      }
      let found = find();
      if(!found || found.agent.runtime !== runtime || Chat.runtimeContract(found.agent).agentUiModule !== settingsModule){ if(live(snapshot, pending.element)) dialogs.close(); return; }
      let catalog;
      if(!Chat.runtimeContract(found.agent).agentUiModule){
        return mutationForm(snapshot, {
          title:'Agent defaults', desc:'Defaults for new sessions only. Existing sessions keep their own launch settings.',
          fields:[{name:'display_name',label:'Agent name',required:true,value:found.agent.display_name || found.agent.handle},
            ...UI.launchFields(UI.findRuntimeCapability(found.box.capabilities, runtime), found.agent.runtime_config)],
          submit:'Save defaults',
        }, async(values, root)=>{
          requireManager(snapshot);
          if(!find()) throw new Error('Agent is no longer available');
          await api(UI.agentApiPath(id), {method:'PATCH', body:JSON.stringify({
            display_name:values.display_name,
            runtime_config:{permission_mode:values.permission_mode, extra_args:values.extra_args},
          })});
          if(await reloadAfterMutation(snapshot, root)) dialogs.close();
        });
      }
      try { catalog = await Chat.loadLocalModule(Chat.runtimeContract(found.agent).agentUiModule); }
      catch(error){ if(live(snapshot, pending.element)) return dialogs.alert('Agent settings unavailable', message(error)); return; }
      if(!live(snapshot, pending.element)) return;
      found = find();
      if(!found || found.agent.runtime !== runtime){ dialogs.close(); return; }
      const retryable = catalog.retryable;
      let render, refreshButton, retryButton, binding;
      const check = root=>{
        if(!live(snapshot, root)) return null;
        const current = find();
        if(!current || current.agent.runtime !== runtime || Chat.runtimeContract(current.agent).agentUiModule !== settingsModule){ dialogs.close(); return null; }
        return current;
      };
      return mutationForm(snapshot, {
        title:'Agent settings', desc:catalog.settingsDescription,
        fields:[{name:'display_name',label:'Agent name',type:'text',required:true,value:found.agent.display_name || found.agent.handle},
          ...(catalog.settingsFields?.(found.agent) || [])],
        submit:catalog.settingsSubmit || 'Save name',
        extraHtml:catalog.settingsHtml,
        onReady:root=>{
          const save = root.querySelector('[data-submit]'), input = root.querySelector('[data-field="display_name"]');
          const error = root.querySelector('[data-error]');
          refreshButton = root.querySelector('[data-refresh-status]');
          retryButton = root.querySelector('[data-retry-runtime]');
          binding = catalog.bindSettings?.(root, found.agent,
            ()=>UI.findRuntimeCapability(find()?.box.capabilities, runtime));
          render = ()=>{
            const current = check(root); if(!current) return;
            const {box, agent} = current;
            catalog.renderSettings(root, box, agent, UI);
            binding?.update?.(agent);
            refreshButton.disabled = false;
          };
          const run = async retry=>{
            const button = retry ? retryButton : refreshButton;
            if(button.disabled || save.disabled || !root.contains(button)) return;
            const current = check(root); if(!current || (retry && !retryable(current.agent))) return;
            save.disabled = input.disabled = refreshButton.disabled = retryButton.disabled = true;
            error.textContent = '';
            try {
              if(retry){
                requireManager(snapshot);
                // Reconcile this exact Agent, with no binding/configuration body or create request.
                const result = await api(UI.agentApiPath(id) + '/runtime/retry', {method:'POST'});
                const latest = check(root); if(!latest) return;
                if(result?.id === id) latest.agent.runtime_status = result.runtime_status;
              }
              if(await reload(snapshot, root)) render();
            } catch(problem){ if(check(root)) error.textContent = message(problem); }
            finally { if(check(root)){ save.disabled = input.disabled = false; render(); } }
          };
          refreshButton.onclick = ()=>run(false);
          retryButton.onclick = ()=>run(true);
          render();
        },
        onSettled:()=>render(),
      }, async(values, root)=>{
        if(!check(root)) return;
        requireManager(snapshot);
        if(values.display_name.length > 200) throw new Error('Agent name must be at most 200 characters.');
        refreshButton.disabled = retryButton.disabled = true;
        try {
          const current = check(root); if(!current) return;
          const payload = catalog.settingsPayload
            ? await catalog.settingsPayload(values, current.agent, UI.findRuntimeCapability(current.box.capabilities, runtime))
            : {display_name:values.display_name};
          if(!check(root)) return;
          const result = await api(UI.agentApiPath(id), {method:'PATCH', body:JSON.stringify(payload)});
          const latest = check(root); if(!latest) return;
          if(result?.id === id){
            latest.agent.display_name = result.display_name;
            if(result.runtime_config) latest.agent.runtime_config = result.runtime_config;
            if(result.runtime_status) latest.agent.runtime_status = result.runtime_status;
          }
          catalog.afterSave?.(root, result);
          if(await reloadAfterMutation(snapshot, root) && check(root)){
            render(); root.querySelector('[data-submit]').textContent = 'Saved';
          }
        } finally { if(check(root)) render(); }
      });
    }

    async function deleteAgent(id, name){
      const snapshot = capture();
      const available = ()=>list(context().devboxes).some(item=>item.workspace_id === snapshot.workspaceId && list(item.agents).some(agent=>agent.id === id));
      if(!canManage(snapshot) || !available()) return;
      const accepted = await dialogs.confirm('Delete agent?', `Delete ${name || 'this agent'}? Saved sessions and any running session for this agent will be removed.`, 'Delete agent');
      if(!accepted || !canManage(snapshot) || !available()) return;
      const pending = loading(snapshot, 'Deleting agent');
      try {
        await api(UI.agentApiPath(id), {method:'DELETE'});
        closeAgent(id);
        if(await reloadAfterMutation(snapshot, pending.element)) dialogs.close();
      } catch(error){ if(live(snapshot, pending.element)) return dialogs.alert('Agent could not be deleted', message(error)); }
    }

    function guideUrl(value){
      try {
        const url = new window.URL(String(value));
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
      } catch(_error){ return ''; }
    }
    async function inventoryDialog(machineId, kind){
      const snapshot = capture();
      if(!machine(snapshot, machineId)) return;
      const title = kind === 'runtimes' ? 'Runtimes' : 'Skills';
      const pending = loading(snapshot, title, 'Refreshing Machine metadata…');
      try { if(!await reload(snapshot, pending.element)) return; }
      catch(error){ if(live(snapshot, pending.element)) return dialogs.alert(`Could not load ${kind}`, message(error)); return; }
      const target = machine(snapshot, machineId);
      if(!target){ if(live(snapshot, pending.element)) dialogs.close(); return; }
      return dialogs.modal({
        title:`${title} on ${target.name}`,
        desc:kind === 'runtimes'
          ? 'Install runtimes on this Machine using the commands or setup guides below. Reconnect the Connector to reprobe runtimes, then refresh status here.'
          : 'Skills are installed locally into runtime-discovered directories. agentbridge stores only path-free metadata and never executes files from a skill package.',
        bodyHtml:`<div data-inventory></div><button type="button" class="ghost" data-refresh-inventory>Refresh ${kind === 'runtimes' ? 'status' : 'skills'}</button><p class="modal-err" data-inventory-error role="alert"></p>`,
        actions:[{label:'Close', value:true, primary:true}],
        onReady:root=>{
          const error = root.querySelector('[data-inventory-error]');
          const render = ()=>{
            if(!live(snapshot, root)) return;
            const current = machine(snapshot, machineId);
            if(!current){ error.textContent = 'This Machine is no longer available.'; return; }
            const container = root.querySelector('[data-inventory]'), commands = [];
            const copy = (command, label='Copy command')=>{
              const index = commands.push(String(command)) - 1;
              return `<button type="button" class="ghost compact" data-inventory-copy="${index}">${esc(label)}</button>`;
            };
            if(kind === 'runtimes'){
              container.innerHTML = UI.runtimeInventory(current.capabilities).map(item=>{
                const state = item.installation === 'installed' ? `${item.compatibility} · ${item.authentication}` : item.installation;
                const url = guideUrl(item.guidance?.url);
                return `<div class="runtime-setup-row"><div><b>${esc(item.label)}</b><span class="muted">${esc(state)}</span></div>${item.guidance?.command ? `<pre class="token token-command">${esc(item.guidance.command)}</pre>${copy(item.guidance.command)}` : ''}${url ? `<div><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Setup guide</a></div>` : ''}</div>`;
              }).join('') || '<p class="muted">Connect this Machine to report runtime status.</p>';
            } else {
              const projects = new Map(UI.localProjectOptions(current.projects).map(project=>[project.id, project.name]));
              const skills = UI.skillInventory(Array.isArray(current.skills) ? {skills:current.skills} : current.capabilities);
              const quote = value=>'"' + String(value).replace(/"/g, '\\"') + '"';
              container.innerHTML = '<div class="skill-list">' + (skills.map(skill=>{
                const project = projects.get(skill.project_id) || skill.project_id;
                const scope = skill.scope === 'project' ? `Project · ${projects.get(skill.project_id) || 'Unavailable project'}` : 'Personal';
                const inspect = `agentbridge skill inspect ${quote(skill.name)}${skill.scope === 'project' && project ? ' --project ' + quote(project) : ''}`;
                return `<div class="skill-row"><div class="skill-row-head"><div><b>${esc(skill.name)}</b><span class="skill-scope">${esc(scope)}</span></div><span class="skill-status skill-status-${skill.status}">${esc(skill.status)}</span></div><p>${esc(skill.description)}</p><div class="skill-meta"><span>${esc(skill.targets.join(', ') || 'No runtime target')}</span>${skill.contains_scripts ? '<span>Contains scripts (not executed by agentbridge)</span>' : ''}${skill.digest ? `<span>Digest: ${esc(skill.digest)}</span>` : ''}</div>${copy(inspect, 'Copy inspect command')}</div>`;
              }).join('') || '<p class="muted">No skills reported by this connector yet.</p>') + '</div>';
              const install = UI.skillInstallCommand(''), projectInstall = UI.skillInstallCommand('', '<project>');
              container.innerHTML += `<details class="local-action-guide"><summary>Install and manage local skills</summary><p>Run these commands yourself on this Machine. Use a reported project name for project-scoped skills. After installing or removing a skill, refresh this list; no restart is needed.</p><b>Install a personal skill</b><pre class="token token-command">${esc(install)}</pre>${copy(install)}<b>Install for a project</b><pre class="token token-command">${esc(projectInstall)}</pre>${copy(projectInstall)}<pre class="token token-command">agentbridge skill list</pre>${copy('agentbridge skill list')}<pre class="token token-command">${esc(UI.skillRemoveCommand(''))}</pre>${copy(UI.skillRemoveCommand(''))}</details>`;
            }
            container.querySelectorAll('[data-inventory-copy]').forEach(button=>bindCopy(snapshot, root, button, ()=>commands[Number(button.dataset.inventoryCopy)], error));
          };
          render();
          const button = root.querySelector('[data-refresh-inventory]');
          button.onclick = async()=>{
            if(button.disabled || !live(snapshot, root)) return;
            button.disabled = true; error.textContent = '';
            try { if(await reload(snapshot, root)) render(); }
            catch(problem){ if(live(snapshot, root)) error.textContent = message(problem); }
            finally { if(live(snapshot, root)) button.disabled = false; }
          };
        },
      });
    }
    function showRuntimes(machineId){ return inventoryDialog(machineId, 'runtimes'); }
    function showSkills(machineId){ return inventoryDialog(machineId, 'skills'); }

    return {createWorkspace, manageWorkspace, presentInvitation, admin, createMachine,
      rotateMachineToken, deleteMachine, createAgent, agentSettings, hasAgentSettings,
      deleteAgent, showRuntimes, showSkills};
  }

  return {createManagement};
});
