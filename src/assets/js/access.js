(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    let session;
    let busy = false;
    function error(message) { $('access-error').textContent = message; $('access-error').hidden = false; }
    async function load() {
        const response = await fetch('/api/session', { cache: 'no-store' });
        session = await response.json();
        if (!response.ok || !session.ok) throw new Error('The workspace is unavailable. Try refreshing the page.');
        if (session.user) { location.replace('/'); return; }
        const setup = session.needs_setup;
        $('access-title').textContent = setup ? 'Create your owner account' : 'Sign in';
        $('access-description').textContent = setup ? 'Set up the first owner of this appointment workspace.' : 'Sign in to manage your workspace.';
        $('access-name-field').hidden = !setup;
        $('access-repeat-field').hidden = !setup;
        for (const id of ['access-name', 'access-repeat']) { $(id).disabled = !setup; $(id).required = setup; }
        $('access-password').minLength = setup ? 12 : 1;
        $('access-password').autocomplete = setup ? 'new-password' : 'current-password';
        $('access-submit').textContent = setup ? 'Create owner account' : 'Sign in';
        $('access-submit').disabled = false;
        $('access-footnote').textContent = setup ? 'Use a password of at least 12 characters. You can add staff accounts after signing in.' : 'Ask an owner to create an account or reset your password.';
    }
    $('access-form').addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !session) return;
        $('access-error').hidden = true;
        if (session.needs_setup && $('access-repeat').value !== $('access-password').value) { error('The passwords do not match.'); return; }
        busy = true; $('access-submit').disabled = true;
        try {
            const response = await fetch(session.needs_setup ? '/api/setup' : '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token }, body: JSON.stringify({ username: $('access-username').value.trim(), password: $('access-password').value, display_name: $('access-name').value.trim() }) });
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.message || 'Sign-in failed.');
            $('access-password').value = ''; $('access-repeat').value = '';
            location.replace('/');
        } catch (problem) { error(problem.message); }
        finally { busy = false; $('access-submit').disabled = false; }
    });
    load().catch(problem => error(problem.message));
})();
