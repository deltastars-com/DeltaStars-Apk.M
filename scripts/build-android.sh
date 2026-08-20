#!/bin/bash
# Delta Stars Store - Android APK Build Script
# Usage: sh ./scripts/build-android.sh

set -e

echo "🚀 Building Delta Stars Store Android APK..."
echo "============================================"

# Step 1: Sync web assets to Android
echo "📦 Syncing web assets..."
npx cap sync android

# Step 2: Build debug APK
echo "🔨 Building debug APK..."
cd android
sh ./gradlew assembleDebug

# Step 3: Build release APK (unsigned)
echo "🔨 Building release APK..."
sh ./gradlew assembleRelease

echo ""
echo "✅ Build complete!"
echo "📱 Debug APK: android/app/build/outputs/apk/debug/app-debug.apk"
echo "📱 Release APK: android/app/build/outputs/apk/release/app-release-unsigned.apk"
echo ""
echo "To sign the release APK:"
echo "  jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 -keystore keystore.jks app-release-unsigned.apk alias_name"
echo "  zipalign -v 4 app-release-unsigned.apk deltastars-v$(node -p "require('./package.json').version").apk"
