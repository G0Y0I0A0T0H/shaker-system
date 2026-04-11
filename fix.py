import re

with open('index.html', 'r', encoding='utf-8') as f:
    c = f.read()

new_csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' https://www.gstatic.com https://cdnjs.cloudflare.com \'unsafe-inline\'; script-src-elem \'self\' https://www.gstatic.com https://cdnjs.cloudflare.com \'unsafe-inline\'; style-src \'self\' https://cdnjs.cloudflare.com https://fonts.googleapis.com \'unsafe-inline\'; font-src \'self\' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; img-src \'self\' data: https: blob:; connect-src \'self\' https://www.gstatic.com https://*.firebaseio.com wss://*.firebaseio.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://firebaseinstallations.googleapis.com https://api.cloudinary.com https://res.cloudinary.com; frame-src \'none\'; object-src \'none\'; base-uri \'self\';">'

c = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', new_csp, c, count=1, flags=re.DOTALL)

favicon = '<link rel="icon" href="data:image/svg+xml,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27><text y=%27.9em%27 font-size=%2790%27>S</text></svg>">'
c = c.replace('<script src="https://cdn.tailwindcss.com"></script>', '<link rel="stylesheet" href="./css/tailwind.css">\n' + favicon)

c = re.sub(r'<script>\s*tailwind\.config\s*=.*?</script>', '', c, count=1, flags=re.DOTALL)

c = re.sub(r'// === Toast Notifications ===\s*const Toast = \{.*?\n\};', '// Toast provided by ui.js', c, count=1, flags=re.DOTALL)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(c)

print('Done')