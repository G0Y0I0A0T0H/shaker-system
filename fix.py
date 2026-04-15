with open('index.html', 'r', encoding='utf-8') as f:
    c = f.read()

# 1. Replace Tailwind CDN script tag
old_tw = '<script src="https://cdn.tailwindcss.com"></script>'
new_tw = '<link rel="stylesheet" href="./css/tailwind.css">\n<link rel="icon" href="data:image/svg+xml,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27><text y=%27.9em%27 font-size=%2790%27>S</text></svg>">'
if old_tw in c:
    c = c.replace(old_tw, new_tw)
    print('[1/4] Tailwind CDN replaced')
else:
    print('[1/4] FAIL: Tailwind CDN not found')

# 2. Replace CSP block (find by start and end markers)
csp_start = c.find('<meta http-equiv="Content-Security-Policy"')
if csp_start != -1:
    csp_end = c.find('>', csp_start) + 1
    new_csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' https://www.gstatic.com https://cdnjs.cloudflare.com \'unsafe-inline\'; script-src-elem \'self\' https://www.gstatic.com https://cdnjs.cloudflare.com \'unsafe-inline\'; style-src \'self\' https://cdnjs.cloudflare.com https://fonts.googleapis.com \'unsafe-inline\'; font-src \'self\' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; img-src \'self\' data: https: blob:; connect-src \'self\' https://www.gstatic.com https://*.firebaseio.com wss://*.firebaseio.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://firebaseinstallations.googleapis.com https://api.cloudinary.com https://res.cloudinary.com; frame-src \'none\'; object-src \'none\'; base-uri \'self\';">'
    c = c[:csp_start] + new_csp + c[csp_end:]
    print('[2/4] CSP replaced')
else:
    print('[2/4] FAIL: CSP not found')

# 3. Remove tailwind.config block
tc_start = c.find('tailwind.config')
if tc_start != -1:
    script_start = c.rfind('<script>', 0, tc_start)
    script_end = c.find('</script>', tc_start) + len('</script>')
    if script_start != -1 and script_end != -1:
        c = c[:script_start] + c[script_end:]
        print('[3/4] tailwind.config removed')
    else:
        print('[3/4] FAIL: tailwind.config boundaries not found')
else:
    print('[3/4] SKIP: no tailwind.config')

# 4. Remove duplicate Toast block
toast_start = c.find('// === Toast Notifications ===')
if toast_start != -1:
    toast_end = c.find('};', toast_start) + 2
    c = c[:toast_start] + '// Toast provided by ui.js' + c[toast_end:]
    print('[4/4] Toast duplicate removed')
else:
    print('[4/4] FAIL: Toast block not found')

with open('index.html', 'w', encoding='utf-8', newline='') as f:
    f.write(c)

print('\nDone. Verify with Select-String commands.')