#!/bin/zsh
set -eu
cd "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    set +u
    source "$NVM_DIR/nvm.sh"
    nvm use --silent default >/dev/null 2>&1 || true
    set -u
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node(N); do
    if [[ -x "$candidate" ]]; then export PATH="${candidate:h}:$PATH"; fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22 或更高版本。'; read '?按回车退出'; exit 1
fi
node src/launcher.js start || { read '?启动失败，按回车退出'; exit 1; }
