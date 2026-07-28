# mdy: Open Live Preview in Browser — a long-lived Node server (see
# preview_server.mjs, shipped in this package) imports the engine once and
# streams rendered HTML to the browser over SSE; this plugin pushes the
# CURRENT BUFFER (saved or not) on every modification, debounced. Live as
# you type, like the vscode extension's preview.
#
# The live path needs a filesystem mdy checkout to import the engine from,
# derived from "mdy_command" in mdy.sublime-settings when it looks like
# ["node", "/path/to/mdy-docs/bin/mdy.js"]. When it can't be derived (the
# default ["npx", "mdy"]), the command falls back to a one-shot render via
# the CLI — still useful, just not live.
import os
import subprocess
import tempfile
import urllib.request
import webbrowser

import sublime
import sublime_plugin

_server = {"proc": None, "port": None}
_live_view_id = None
_push_pending = 0


def _mdy_command():
    settings = sublime.load_settings('mdy.sublime-settings')
    cmd = settings.get('mdy_command', ['npx', 'mdy'])
    return list(cmd) if isinstance(cmd, list) else [str(cmd)]


def _engine_root():
    """A checkout to import the engine from: .../mdy-docs for a
    mdy_command of ["node", ".../mdy-docs/bin/mdy.js"]."""
    for part in _mdy_command():
        if part.endswith(('mdy.js', 'mdy.mjs')):
            root = os.path.dirname(os.path.dirname(os.path.abspath(part)))
            if os.path.exists(os.path.join(root, 'index.js')):
                return root
    return None


def _node_binary():
    cmd = _mdy_command()
    if cmd and os.path.basename(cmd[0]).startswith('node'):
        return cmd[0]
    return 'node'


def _ensure_server():
    """Start (or reuse) the preview server; returns its port or None."""
    proc = _server["proc"]
    if proc is not None and proc.poll() is None:
        return _server["port"]
    root = _engine_root()
    if root is None:
        return None
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview_server.mjs')
    proc = subprocess.Popen(
        [_node_binary(), script, '--engine', root],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    port = None
    for _ in range(50):  # the PORT= line arrives after wasm/engine import
        line = proc.stdout.readline().decode('utf-8', 'replace').strip()
        if line.startswith('PORT='):
            port = int(line.split('=', 1)[1])
            break
        if proc.poll() is not None:
            break
    if port is None:
        return None
    _server["proc"] = proc
    _server["port"] = port
    return port


def _push_view(view):
    port = _server["port"]
    if port is None:
        return
    text = view.substr(sublime.Region(0, view.size())).encode('utf-8')
    title = os.path.basename(view.file_name() or 'untitled.mdy')
    req = urllib.request.Request(
        'http://127.0.0.1:%d/buffer' % port,
        data=text,
        method='PUT',
        headers={'X-Mdy-Title': title},
    )
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as exc:
        message = str(exc)
        sublime.set_timeout(lambda: view.set_status('mdy', 'mdy: preview push failed: ' + message), 0)


def _is_mdy(view):
    name = view.file_name() or ''
    return name.endswith('.mdy') or 'text.html.markdown.mdy' in view.scope_name(0)


class MdyPreviewCommand(sublime_plugin.TextCommand):
    def is_enabled(self):
        return _is_mdy(self.view)

    def run(self, edit):
        view = self.view
        view.set_status('mdy', 'mdy: starting preview…')

        def start():
            global _live_view_id
            port = _ensure_server()
            if port is not None:
                _live_view_id = view.id()
                _push_view(view)
                webbrowser.open('http://127.0.0.1:%d/' % port)
                sublime.set_timeout(lambda: view.set_status('mdy', 'mdy: live preview on :%d' % port), 0)
                sublime.set_timeout(lambda: view.erase_status('mdy'), 4000)
            else:
                self._snapshot()

        sublime.set_timeout_async(start, 0)

    # ----- fallback: one-shot render via the CLI (works with npx) -----

    def _snapshot(self):
        view = self.view
        source = view.substr(sublime.Region(0, view.size()))
        workdir = os.path.dirname(view.file_name()) if view.file_name() else None
        tmpdir = tempfile.mkdtemp(prefix='mdy-preview-')
        src_path = os.path.join(tmpdir, os.path.basename(view.file_name() or 'untitled.mdy'))
        out_path = os.path.join(tmpdir, 'preview.html')
        with open(src_path, 'w', encoding='utf-8') as f:
            f.write(source)
        cmd = _mdy_command() + [src_path, '--html', '-o', out_path]
        try:
            proc = subprocess.run(cmd, cwd=workdir or tmpdir, capture_output=True, timeout=60)
            if proc.returncode != 0:
                message = (proc.stderr or proc.stdout or b'').decode('utf-8', 'replace').strip()
                sublime.set_timeout(lambda: self._fail(message or 'mdy exited with %d' % proc.returncode), 0)
                return
            webbrowser.open('file://' + out_path)
            sublime.set_timeout(lambda: view.set_status('mdy', 'mdy: snapshot preview (set an absolute mdy_command for LIVE preview)'), 0)
            sublime.set_timeout(lambda: view.erase_status('mdy'), 6000)
        except Exception as exc:
            message = str(exc)
            if isinstance(exc, FileNotFoundError):
                message += '\n\nGUI apps do not inherit your shell PATH — set an absolute\ncommand in mdy.sublime-settings, e.g.\n  "mdy_command": ["/absolute/path/to/node", "/path/to/mdy-docs/bin/mdy.js"]'
            sublime.set_timeout(lambda: self._fail(message), 0)

    def _fail(self, message):
        self.view.erase_status('mdy')
        panel = self.view.window().create_output_panel('mdy')
        panel.run_command('append', {'characters': 'mdy preview failed:\n' + message + '\n'})
        self.view.window().run_command('show_panel', {'panel': 'output.mdy'})


class MdyLivePreviewListener(sublime_plugin.EventListener):
    def on_modified_async(self, view):
        global _push_pending
        if _live_view_id is None or view.id() != _live_view_id:
            return
        _push_pending += 1
        token = _push_pending

        def flush():
            if token == _push_pending:  # superseded edits collapse into one push
                _push_view(view)

        sublime.set_timeout_async(flush, 250)


def plugin_unloaded():
    proc = _server["proc"]
    if proc is not None and proc.poll() is None:
        proc.terminate()
