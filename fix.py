with open('index.html', 'r', encoding='utf-8') as f:
    c = f.read()

# 1. Replace Tailwind CDN script tag
old_tw = '<script src="https://cdn.tailwindcss.com"></script>'
new_tw = '<link rel="stylesheet" href="./css/tailwind.css">\n<link rel="icon" href="data:image/svg+xml,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27><text y=%27.9em%27 font-size=%2790%27>S</text></svg>">'

if old_tw in c:
    c = c.replace(old_tw, new_tw)
    print('[1/3] Tailwind CDN replaced')
else:
    print('[1/3] SKIP: Tailwind CDN not found')

# ❌ مهم جداً: لا تلمس CSP أبداً
print('[2/3] SKIP: CSP untouched (fixed manually)')

# 2. Remove tailwind.config block
tc_start = c.find('tailwind.config')
if tc_start != -1:
    script_start = c.rfind('<script>', 0, tc_start)
    script_end = c.find('</script>', tc_start) + len('</script>')
    if script_start != -1 and script_end != -1:
        c = c[:script_start] + c[script_end:]
        print('[2/3] tailwind.config removed')
    else:
        print('[2/3] FAIL: tailwind.config boundaries not found')
else:
    print('[2/3] SKIP: no tailwind.config')

# 3. Remove duplicate Toast block
toast_start = c.find('// === Toast Notifications ===')
if toast_start != -1:
    toast_end = c.find('};', toast_start) + 2
    c = c[:toast_start] + '// Toast provided by ui.js' + c[toast_end:]
    print('[3/3] Toast duplicate removed')
else:
    print('[3/3] SKIP: Toast block not found')

# Save file
with open('index.html', 'w', encoding='utf-8', newline='') as f:
    f.write(c)

print('\n✅ Done. CSP محفوظ وما رح ينكسر.')