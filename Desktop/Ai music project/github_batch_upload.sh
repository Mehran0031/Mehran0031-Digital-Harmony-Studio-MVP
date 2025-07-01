#!/bin/bash

echo "🚀 Starting GitHub Batch Upload for Digital Harmony Studio MVP"
echo "=================================================="

# Fix Git locks
echo "🔧 Step 1: Cleaning up Git locks..."
if [ -f ~/.git/index.lock ]; then
    rm ~/.git/index.lock
    echo "✅ Removed Git index lock"
fi

# Configure Git
git config pull.rebase false

# Pull latest changes
git pull origin main --allow-unrelated-histories

echo "📦 Starting batch uploads..."

# Batch 1: Configuration files
echo "📦 Batch 1/10: Configuration files..."
git add .gitignore
git add *.json 2>/dev/null || true
git commit -m "Batch 1: Add .gitignore and configuration files" 2>/dev/null || echo "No changes in batch 1"
git push origin main

# Batch 2: Images
echo "📦 Batch 2/10: Images..."
git add *.jpg *.png *.webp 2>/dev/null || true
git commit -m "Batch 2: Add images" 2>/dev/null || echo "No changes in batch 2"
git push origin main

# Batch 3: PDFs
echo "📦 Batch 3/10: PDFs..."
git add *.pdf 2>/dev/null || true
git commit -m "Batch 3: Add PDFs" 2>/dev/null || echo "No changes in batch 3"
git push origin main

# Batch 4-10: Directories
for dir in "figma design codes" "logo and muckups" "website items" "buisnessplan and strategies" "Digital-Harmony-Studio-MVP"; do
    if [ -d "$dir" ]; then
        echo "📦 Adding directory: $dir"
        git add "$dir/"
        git commit -m "Add $dir directory" 2>/dev/null || echo "No changes for $dir"
        git push origin main
    fi
done

echo "🎉 Upload completed!"
