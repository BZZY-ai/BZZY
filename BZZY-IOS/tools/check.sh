#!/bin/zsh
set -eu
cd "${0:A:h:h}"
mkdir -p .build
if [[ $(uname -m) == arm64 ]]; then
  native_target=arm64-apple-macosx14.0
else
  native_target=x86_64-apple-macosx14.0
fi
native_sdk=$(xcrun --sdk macosx --show-sdk-path)
swiftc -target "$native_target" -sdk "$native_sdk" -swift-version 5 -parse-as-library \
  BZZY/Model/*.swift BZZY/Notifications/NotificationStore.swift BZZY/Voice/VoiceCapture.swift Tests/ModelChecks.swift -o .build/model-checks
.build/model-checks .build
swiftc -target "$native_target" -sdk "$native_sdk" -swift-version 5 -parse-as-library \
  BZZY/Model/*.swift Tests/ChatChecks.swift -o .build/chat-checks
swiftc -target "$native_target" -sdk "$native_sdk" -swift-version 5 -parse-as-library \
  BZZY/Model/*.swift Tests/TerminalPresentationCacheChecks.swift -o .build/presentation-cache-checks
.build/presentation-cache-checks
swiftc -target "$native_target" -sdk "$native_sdk" -swift-version 5 -parse-as-library \
  BZZY/Model/*.swift BZZY/Notifications/NotificationStore.swift Tests/NotificationReadinessChecks.swift -o .build/notification-readiness-checks
.build/notification-readiness-checks
.build/chat-checks
swift test --build-system native --disable-index-store --scratch-path .build/relay-package
swift run --build-system native --disable-index-store --scratch-path .build/relay-package BZZYPreview previews
plutil -lint BZZY.xcodeproj/project.pbxproj
plutil -lint BZZY/Resources/Info.plist BZZY/Resources/PrivacyInfo.xcprivacy
