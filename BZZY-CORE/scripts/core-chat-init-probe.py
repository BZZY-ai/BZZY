#!/usr/bin/env python3
"""Isolated Codex initialize only: no owner auth, Core state, threads or turns.

Codex may still enforce /etc/codex system configuration. This checks a fresh
process outside the daemon's cgroup; it does not verify its auth or model access.
"""
import argparse, errno, json, math, os, pathlib, re, selectors, shutil, signal, subprocess, tempfile, time

TEMPLATE = json.loads('{"slug":"gpt-6.1-sol","prefer_websockets":true,"support_verbosity":true,"default_verbosity":"low","apply_patch_tool_type":"freeform","web_search_tool_type":"text_and_image","input_modalities":["text","image"],"supports_image_detail_original":true,"truncation_policy":{"mode":"tokens","limit":10000},"supports_parallel_tool_calls":true,"tool_mode":"code_mode_only","multi_agent_version":"v2","multi_agent_reasoning_effort":"xhigh","use_responses_lite":true,"include_skills_usage_instructions":false,"include_apps_usage_instructions":false,"include_plugin_usage_instructions":false,"guardian":null,"node_repl_auto_review_required":true,"node_repl_disabled":false,"requires_sandboxed_review":false,"auto_review_model_override":null,"model_specialty":null,"context_window":272000,"max_context_window":872000,"auto_compact_token_limit":null,"comp_hash":"3000","default_reasoning_summary":"none","display_name":"GPT-6.1-Sol","description":"Latest workhorse model for coding and everyday work.","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low","description":"Fast responses with lighter reasoning"},{"effort":"medium","description":"Balances speed and reasoning depth for everyday tasks"},{"effort":"high","description":"Greater reasoning depth for complex problems"},{"effort":"xhigh","description":"Extra high reasoning depth for complex problems"},{"effort":"max","description":"Maximum reasoning depth for the hardest problems"},{"effort":"ultra","description":"Maximum reasoning with automatic task delegation"}],"shell_type":"shell_command","visibility":"list","minimal_client_version":"0.153.0","supported_in_api":true,"availability_nux":{"message":"Maximize usage with GPT-6.1 Sol. Try it on complex work for near-Astra performance at a lower cost."},"upgrade":null,"priority":1,"model_messages":{},"experimental_supported_tools":["send_user_message_async","clock"],"available_in_plans":["business","edu","edu_plus","edu_pro","education","ent26","enterprise","enterprise_cbp_automation","enterprise_cbp_trial","enterprise_cbp_usage_based","finserv","free","free_workspace","go","hc","k12","law","plus","pro","prolite","promax","quorum","sci","self_serve_business_prolite","self_serve_business_usage_based","team"],"supports_search_tool":true,"supports_experimental_context":false,"default_service_tier":null,"service_tiers":[{"id":"priority","name":"Fast","description":"2x speed, increased usage"}],"additional_speed_tiers":["fast"],"supports_reasoning_summary_parameter":true,"supports_reasoning_summaries":true,"supports_reasoning_effort_updates":true}')
FEATURES = 'shell_tool unified_exec multi_agent multi_agent_v2 view_image image_generation apps plugins remote_plugin hooks skill_search skill_mcp_dependency_install browser_use browser_use_external browser_use_full_cdp_access computer_use code_mode_host code_mode goals memories external_agent_memory_import'.split()
SIGNALS = {getattr(signal, name): name for name in ('SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGXCPU', 'SIGXFSZ') if hasattr(signal, name)}
CLEANUP_FAILED = []

def toml(value):
    if isinstance(value, dict):
        return '{' + ', '.join(json.dumps(key) + ' = ' + toml(item) for key, item in value.items()) + '}'
    return json.dumps(value, ensure_ascii=False)

def stop_owned(process):
    try:
        if process.poll() is None:
            try: os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                process.wait(timeout=1)
    except (OSError, subprocess.SubprocessError): CLEANUP_FAILED.append(True)
    for stream in (process.stdin, process.stdout, process.stderr):
        try: stream.close()
        except (OSError, AttributeError): pass

def failure_category(stderr):
    data = stderr.lower()
    for needles, category in ((('unknown configuration field', 'failed to load config', 'error loading config'), 'configuration_rejected'),
            (('unexpected argument', 'unrecognized option'), 'unsupported_argument'),
            (('permission denied', 'operation not permitted'), 'permission_denied'),
            (('no such file or directory', 'cannot find module', 'could not find native'), 'runtime_file_unavailable'),
            (('model catalog', 'model_catalog_json'), 'catalog_rejected'),
            (('database is locked', 'database disk image is malformed'), 'database_unavailable')):
        if any(needle in data for needle in needles): return category
    return 'backend_exit'

def collect(binary, args, env, cwd, timeout, initialize):
    process = None; selector = selectors.DefaultSelector(); output = bytearray(); errors = bytearray(); pending = bytearray()
    try:
        process = subprocess.Popen([binary] + args, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True)
        for name, stream in (('out', process.stdout), ('err', process.stderr)):
            os.set_blocking(stream.fileno(), False); selector.register(stream, selectors.EVENT_READ, name)
        if initialize:
            process.stdin.write((json.dumps({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {
                'name': 'bzzy', 'title': 'bzzy', 'version': '0.2.0'}, 'capabilities': {'experimentalApi': True}}}) + '\n').encode())
            process.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0: return {'state': 'failed', 'category': 'timeout'}
            for key, _ in selector.select(min(remaining, 0.1)):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk: selector.unregister(key.fileobj); continue
                destination = output if key.data == 'out' else errors
                destination.extend(chunk)
                if len(destination) > 65536: return {'state': 'failed', 'category': 'output_limit'}
                if key.data == 'out' and initialize:
                    pending.extend(chunk)
                    while b'\n' in pending:
                        line, _, rest = pending.partition(b'\n'); pending = bytearray(rest)
                        try: reply = json.loads(line)
                        except (ValueError, UnicodeError): continue
                        if not isinstance(reply, dict) or reply.get('id') != 1: continue
                        if 'error' in reply:
                            code = reply['error'].get('code') if isinstance(reply['error'], dict) else None
                            return {'state': 'failed', 'category': 'rpc_rejected', **({'rpcCode': code} if type(code) is int and abs(code) <= 2147483648 else {})}
                        if isinstance(reply.get('result'), dict):
                            process.stdin.write(b'{"method":"initialized","params":{}}\n'); process.stdin.flush()
                            return {'state': 'initialized'}
                        return {'state': 'failed', 'category': 'invalid_initialize_response'}
            code = process.poll()
            if code is not None and not selector.get_map():
                if not initialize:
                    match = re.search(rb'\bcodex-cli\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)\b', bytes(output) + bytes(errors))
                    version = match.group(1).decode()[:64] if match else 'unreported'
                    result = {'state': 'version' if code == 0 and match else 'failed', 'version': version}
                    if code != 0 or not match: result['category'] = 'version_check_failed'
                    if 0 <= code <= 255: result['exitCode'] = code
                    elif code < 0 and -code in SIGNALS: result['signal'] = SIGNALS[-code]
                    return result
                result = {'state': 'failed', 'category': failure_category(errors.decode('utf8', 'replace'))}
                if 0 <= code <= 255: result['exitCode'] = code
                elif code < 0 and -code in SIGNALS: result['signal'] = SIGNALS[-code]
                return result
    except OSError as error:
        return {'state': 'failed', 'category': 'process_io_error', 'systemCode': errno.errorcode.get(error.errno, 'UNKNOWN') if error.errno in (errno.ENOENT, errno.EACCES, errno.EPERM, errno.ENOEXEC, errno.ENOTDIR, errno.EPIPE) else 'UNKNOWN'}
    finally:
        selector.close()
        if process is not None: stop_owned(process)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', help='Existing Codex executable (default: PATH).')
    parser.add_argument('--timeout', type=float, default=5, help='Per-process deadline, 0.1–10 seconds; overall bound also applies.')
    options = parser.parse_args()
    if not math.isfinite(options.timeout) or not 0.1 <= options.timeout <= 10: parser.error('Use a timeout from 0.1 to 10 seconds.')
    binary = shutil.which(options.codex or 'codex')
    if not binary:
        print(json.dumps({'probe': 'core-chat-initialize-only-v1', 'state': 'failed', 'category': 'executable_not_found'})); return
    binary = str(pathlib.Path(binary).resolve())
    report = {'probe': 'core-chat-initialize-only-v1', 'ownerStateRead': False, 'modelTurnsStarted': 0,
        'scope': 'fresh-process-outside-Core-daemon', 'systemConfigurationPresent': {
            name: pathlib.Path('/etc/codex', name).is_file() for name in ('config.toml', 'requirements.toml', 'managed_config.toml')}}
    overall_deadline = time.monotonic() + 12
    with tempfile.TemporaryDirectory(prefix='bzzy-chat-init-', dir='/tmp') as temporary:
        root = pathlib.Path(temporary).resolve(); home = root / 'home'; home.mkdir(mode=0o700)
        codex = root / 'codex'; codex.mkdir(mode=0o700)
        work = root / 'work'; work.mkdir(mode=0o700)
        env = {'HOME': str(home), 'CODEX_HOME': str(codex), 'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
            'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TMPDIR': str(root), 'BZZY_INIT_PROBE_KEY': 'synthetic-not-an-account-key'}
        for key in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'): env[key] = str(root / key.lower())
        report['native'] = collect(binary, ['--version'], env, str(work), min(options.timeout, 3), False)
        if report['native'].get('state') != 'version':
            report['cases'] = {}; report['state'] = 'failed'; report['category'] = 'version_check_failed'
            print(json.dumps(report, sort_keys=True)); return
        catalog = dict(TEMPLATE); catalog.update(slug='bzzy-initialize-probe', display_name='BZZY initialize probe',
            description='Synthetic initialize-only metadata', prefer_websockets=False, context_window=32768, max_context_window=32768,
            default_reasoning_level='high', default_reasoning_summary='none', tool_mode=None, shell_type='shell_command', model_specialty=None,
            guardian=None, node_repl_auto_review_required=False, requires_sandboxed_review=False, auto_review_model_override=None,
            use_responses_lite=False, model_messages={'instructions_template': 'Initialize-only synthetic probe. No thread or turn is created.'})
        catalog_file = root / 'models.json'; catalog_file.write_text(json.dumps({'models': [catalog]})); catalog_file.chmod(0o600)
        common = {'cli_auth_credentials_store': 'file', 'approval_policy': 'never', 'default_permissions': 'bzzy_learning_review_v1',
            'permissions.bzzy_learning_review_v1': {'filesystem': {':root': 'deny', ':minimal': 'read', str(work): 'read', binary: 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny'}, 'network': {'enabled': False}},
            **{'features.' + feature: False for feature in FEATURES}, 'features.skip_host_skill_discovery': True,
            'shell_environment_policy.inherit': 'none', 'shell_environment_policy.set': {'PATH': '/usr/bin:/bin'},
            'mcp_servers': {}, 'web_search': 'disabled', 'project_doc_max_bytes': 0, 'project_doc_fallback_filenames': [],
            'projects.' + json.dumps(str(work)) + '.trust_level': 'untrusted', 'model_reasoning_effort': 'high'}
        report['cases'] = {}
        for name, additional in (('restricted_subscription_without_auth', {'model_provider': 'openai'}),
                ('restricted_synthetic_api', {'model_catalog_json': str(catalog_file), 'model_provider': 'bzzy_api',
                    'model_providers.bzzy_api.name': 'BZZY synthetic probe', 'model_providers.bzzy_api.base_url': 'http://127.0.0.1:9/v1',
                    'model_providers.bzzy_api.env_key': 'BZZY_INIT_PROBE_KEY', 'model_providers.bzzy_api.wire_api': 'responses',
                    'model_providers.bzzy_api.requires_openai_auth': False, 'model_providers.bzzy_api.supports_websockets': False,
                    'model_providers.bzzy_api.capabilities.remote_compaction': 'unsupported'})):
            args = ['app-server', '--listen', 'stdio://', '--strict-config']
            for key, value in {**common, **additional}.items(): args.extend(('-c', key + '=' + toml(value)))
            remaining = overall_deadline - time.monotonic()
            report['cases'][name] = collect(binary, args, env, str(work), min(options.timeout, remaining), True) if remaining > 0 else {'state': 'failed', 'category': 'probe_deadline'}
    report['ownedProcessCleanup'] = 'failed' if CLEANUP_FAILED else 'complete'
    print(json.dumps(report, sort_keys=True))

if __name__ == '__main__':
    try: main()
    except (OSError, subprocess.SubprocessError): print(json.dumps({'probe': 'core-chat-initialize-only-v1', 'state': 'failed', 'category': 'probe_setup_failed'}))
