#!/bin/bash
# Delta Stars Store - iOS IPA Build Script
# Usage: sh ./scripts/build-ios.sh
# Note: iOS builds require macOS with Xcode installed

set -e

echo "🍎 Building Delta Stars Store iOS IPA..."
echo "========================================="

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ iOS builds require macOS with Xcode installed."
    echo "   Please run this script on a Mac or use GitHub Actions with macOS runner."
    exit 1
fi

# Step 1: Sync web assets to iOS
echo "📦 Syncing web assets..."
npx cap sync ios

# Step 2: Build using xcodebuild
echo "🔨 Building iOS app..."
cd ios/App

xcodebuild -workspace App.xcworkspace \
    -scheme App \
    -configuration Release \
    -archivePath build/DeltaStars.xcarchive \
    archive

echo ""
echo "✅ Archive created at: ios/App/build/DeltaStars.xcarchive"
echo ""
echo "To create IPA:"
echo "  1. Open ios/App/App.xcworkspace in Xcode"
echo "  2. Select Product → Archive"
echo "  3. Click 'Distribute App' → 'App Store Connect' or 'Ad Hoc'"
echo "  4. Follow the export wizard"
echo ""
echo "For Ad Hoc distribution (direct install):"
echo "  xcodebuild -exportArchive -archivePath build/DeltaStars.xcarchive \\"
echo "    -exportOptionsPlist ExportOptions.plist -exportPath build/"
