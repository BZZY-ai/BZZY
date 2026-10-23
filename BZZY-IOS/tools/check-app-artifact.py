#!/usr/bin/env python3
"""Check the built app, including metadata Xcode may omit from generated plists."""
import argparse
import plistlib
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("app", type=Path)
parser.add_argument("--environment", choices=("development", "production"), required=True)
parser.add_argument("--distribution", action="store_true")
parser.add_argument("--team")
args = parser.parse_args()
info = plistlib.loads((args.app / "Info.plist").read_bytes())
assert info.get("CFBundleIdentifier") == "app.bzzy.ios", "Unexpected bundle identifier"
assert info.get("BZZYAPNSEnvironment") == args.environment, "Built app is missing its configured APNs environment"
for key in ("NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"):
    assert isinstance(info.get(key), str) and info[key].strip(), f"Missing permission explanation: {key}"
privacy = plistlib.loads((args.app / "PrivacyInfo.xcprivacy").read_bytes())
entries = privacy.get("NSPrivacyAccessedAPITypes", [])
actual_reasons = {entry.get("NSPrivacyAccessedAPIType"): set(entry.get("NSPrivacyAccessedAPITypeReasons", [])) for entry in entries}
assert len(entries) == len(actual_reasons), "Duplicate required-reason API declarations"
assert actual_reasons == {
    "NSPrivacyAccessedAPICategoryUserDefaults": {"CA92.1"},
    "NSPrivacyAccessedAPICategoryFileTimestamp": {"C617.1"},
}, "Missing or unexpected required-reason API declarations"
subprocess.run(["codesign", "--verify", "--strict", str(args.app)], check=True)
if args.distribution:
    assert args.environment == "production", "Distribution requires production APNs"
    result = subprocess.run(["codesign", "--display", "--entitlements", ":-", str(args.app)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    entitlements = plistlib.loads(result.stdout)
    assert entitlements.get("aps-environment") == "production", "Distribution signature has the wrong APNs environment"
    assert entitlements.get("get-task-allow") is not True, "Distribution app permits debugger attachment"
    if args.team:
        assert entitlements.get("com.apple.developer.team-identifier") == args.team, "Unexpected signing team"
        assert entitlements.get("application-identifier") == args.team + ".app.bzzy.ios", "Unexpected signed application identifier"
print(f"PASS: built app identifier, {args.environment} APNs metadata, permission descriptions, required-reason privacy manifest and signature" + ("; distribution entitlements" if args.distribution else ""))
