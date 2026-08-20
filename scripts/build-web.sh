#!/bin/bash
# Delta Stars Store - Web Assets Sync Script
# Copies static files to www/ for Capacitor builds and GitHub Pages

set -e

echo "🌐 Syncing web assets to www/..."
echo "================================"

# Clean and recreate www/
rm -rf www
mkdir -p www/assets

# Create .nojekyll to prevent GitHub Pages Jekyll processing
touch www/.nojekyll

# Copy static files
cp index.html www/
cp robots.txt www/
cp security.txt www/
cp sitemap.xml www/

# Copy HTML pages
for f in *.html; do
    [ "$f" != "index.html" ] && cp "$f" www/ 2>/dev/null || true
done

# Copy assets
cp -r assets/* www/assets/ 2>/dev/null || true

# Copy manifest and icons
cp manifest.json www/ 2>/dev/null || true
cp icon-192.png www/ 2>/dev/null || true
cp icon-512.png www/ 2>/dev/null || true
cp icon-1024.png www/ 2>/dev/null || true
cp icon-512-maskable.png www/ 2>/dev/null || true
cp logo.png www/ 2>/dev/null || true
cp favicon.svg www/ 2>/dev/null || true
cp opengraph.jpg www/ 2>/dev/null || true

echo "✅ Web assets synced to www/"
echo "📁 Contents:"
ls -la www/ | head -20
