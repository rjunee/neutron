"""Executable opposite-direction mutants; every selected baseline must pass."""
import importlib.util
import io
from pathlib import Path
import types
import unittest

HERE = Path(__file__).resolve().parent


def tests(name):
    spec = importlib.util.spec_from_file_location('mutation_tests', HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(module, case, method):
    suite = unittest.TestSuite([getattr(module, case)(method)])
    return unittest.TextTestRunner(stream=io.StringIO()).run(suite).wasSuccessful()


def check(filename, suite_file, variable, case, method, before, after):
    module = tests(suite_file)
    assert run(module, case, method), 'baseline control failed: ' + method
    source = (HERE / filename).read_text()
    assert before in source, 'mutation did not land'
    mutant = types.ModuleType('mutated_observation')
    exec(compile(source.replace(before, after), filename, 'exec'), mutant.__dict__)
    setattr(module, variable, mutant)
    assert not run(module, case, method), 'mutation survived: ' + method


CLASSIFIER = [
    ('test_deleted_non_codex_retains_same_distinct_account_admission', 'if not stat.S_ISREG(observed.st_mode):', "if not stat.S_ISREG(observed.st_mode) or target.endswith(' (deleted)'):"),
    ('test_deleted_native_and_wrapper_preserve_same_distinct_account_admission', '    environment = candidate = cwd = nss = namespaces = account = root_account = None', '    if deleted:\n        native = False\n    environment = candidate = cwd = nss = namespaces = account = root_account = None'),
    ('test_deleted_native_and_wrapper_preserve_same_distinct_account_admission', "executable[0][:-10] if deleted else executable[0]", 'executable[0]'),
    ('test_deleted_non_codex_requires_readable_regular_stable_evidence', 'return target, observed.st_dev, observed.st_ino', "return target.removesuffix(' (deleted)'), observed.st_dev, observed.st_ino"),
    ('test_same_distinct_alias_and_relative_accounts', 'if uid not in uids or', 'if True or uid not in uids or'),
    ('test_same_distinct_alias_and_relative_accounts', 'deadline = time.monotonic_ns() + timeout_ms * 1000000', "raise ObservationUnknown('incomplete')"),
    ('test_credentials_not_inode_ownership_select_population', 'if uid not in uids or', 'if path.stat().st_uid != uid or'),
    ('test_default_home_and_verified_real_uid_nss_fallback', 'record = pwd.getpwuid(uid)', "raise ObservationUnknown('incomplete')\n            record = pwd.getpwuid(uid)"),
    ('test_missing_required_read_and_non_codex_executable_refuse', 'def _exe(path):', "def _exe(path):\n    if not (path / 'exe').exists():\n        return '/usr/bin/true', 0, 0"),
    ('test_enumeration_and_budgets_refuse', 'if paths != entries():', 'if False:'),
    ('test_stable_kernel_and_zombie_exclusion', 'PF_KTHREAD = 0x00200000', 'PF_KTHREAD = 0'),
    ('test_mount_namespace_account_equivalence_and_nss', 'if nss is not None and namespaces != observer_namespaces:', 'if False:'),
    ('test_physical_account_identity_collapses_bind_alias_paths', "b'neutron-codex-account-v1\\0' + str(device)", "b'neutron-codex-account-v1\\0' + os.fsencode(_canonical) + b'\\0' + str(device)"),
]
CLIENT = [
    ('test_forged_and_wrong_key_signatures_refuse', "if result.returncode != 0:", 'if False:'),
    ('test_real_signature_complete_empty_and_distinct_consumers', 'returncode != 0', 'returncode == 0'),
    ('test_every_binding_and_exact_schema_refuses', "or payload['hostId'] != pin['hostId'] or payload['bootId'] != boot", 'or False'),
    ('test_replayed_future_long_or_duplicate_observations_refuse', 'if not started <= scan_start <= scan_end <= finished or finished - started > REQUEST_TIMEOUT_NS', 'if False'),
]

if __name__ == '__main__':
    for method, before, after in CLASSIFIER:
        check('codex_account_observation.py', 'account-writer-test.py', 'observation', 'CensusTest', method, before, after)
    for method, before, after in CLIENT:
        check('codex_account_client.py', 'account-observation-client-test.py', 'client', 'ClientTest', method, before, after)
    print(str(len(CLASSIFIER) + len(CLIENT)) + ' semantic mutants rejected; all corresponding valid controls passed')
