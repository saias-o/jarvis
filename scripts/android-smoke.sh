#!/usr/bin/env bash
set -euo pipefail

mkdir -p smoke-results
adb logcat -c
adb install -r apk/app-release.apk
adb shell am start -W -n dev.jarvis.app/.MainActivity
sleep 12
adb shell pidof dev.jarvis.app
adb logcat -d > smoke-results/logcat.txt
if grep -q 'FATAL EXCEPTION' smoke-results/logcat.txt; then
  tail -100 smoke-results/logcat.txt
  exit 1
fi
adb shell uiautomator dump /sdcard/jarvis-window.xml
adb pull /sdcard/jarvis-window.xml smoke-results/window.xml
adb exec-out screencap -p > smoke-results/screen.png
python3 - <<'PY'
import subprocess
import time
import xml.etree.ElementTree as ET

root = ET.parse('smoke-results/window.xml').getroot()
button = next((n for n in root.iter('node') if 'Réglages Android' in (n.get('text', '') + n.get('content-desc', ''))), None)
if button is None:
    raise SystemExit('Android settings button was not rendered in the WebView')
import re
x1, y1, x2, y2 = map(int, re.findall(r'\d+', button.get('bounds')))
subprocess.run(['adb', 'shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2)], check=True)
time.sleep(2)
subprocess.run(['adb', 'shell', 'uiautomator', 'dump', '/sdcard/jarvis-settings.xml'], check=True)
subprocess.run(['adb', 'pull', '/sdcard/jarvis-settings.xml', 'smoke-results/settings.xml'], check=True)
text = open('smoke-results/settings.xml').read()
if 'Gemma' not in text or 'Cerveau' not in text:
    raise SystemExit('Android settings failed to open')
with open('smoke-results/settings.png', 'wb') as out:
    subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=out, check=True)
PY

# An update signed by the same key must retain the installed application.
adb install -r apk/app-release.apk
adb shell am force-stop dev.jarvis.app
adb shell am start -W -n dev.jarvis.app/.MainActivity
sleep 3
adb shell pidof dev.jarvis.app
