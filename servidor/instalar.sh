#!/usr/bin/env bash
# Instala o WhatsApp na nuvem (conectores de todas as óticas) num servidor Ubuntu.
# Uso:  curl -fsSL https://oticas-cobranca.vercel.app/servidor/instalar.sh | bash -s -- srv_SUACHAVE
# Rodar de novo atualiza o programa (a chave e as sessões do WhatsApp são mantidas).
set -euo pipefail
CHAVE="${1:-}"
DIR=/opt/adm-conector
SITE=https://oticas-cobranca.vercel.app
if [ "$(id -u)" != "0" ]; then echo "Rode como root (ou com sudo)."; exit 1; fi
if [ -z "$CHAVE" ] && [ -f "$DIR/.env" ]; then CHAVE=$(grep '^SERVER_KEY=' "$DIR/.env" | cut -d= -f2); fi
if ! [[ "$CHAVE" =~ ^srv_[0-9a-f]{48}$ ]]; then echo "Chave do servidor inválida. Copie o comando inteiro de novo."; exit 1; fi

echo "==> Preparando o servidor (pode levar alguns minutos)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl unzip ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Instalando o Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
# memória extra (swap) para servidores pequenos
if [ "$(swapon --show | wc -l)" = "0" ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab || true
fi

echo "==> Baixando o conector"
mkdir -p "$DIR/sessoes"
TMP=$(mktemp -d)
curl -fsSL "$SITE/conector.zip?v=$(date +%s)" -o "$TMP/c.zip"
unzip -q -o "$TMP/c.zip" -d "$TMP/c"
SRC="$TMP/c"; [ -f "$SRC/package.json" ] || SRC=$(dirname "$(find "$TMP/c" -name package.json -not -path '*/node_modules/*' | head -1)")
cp -r "$SRC/src" "$SRC/package.json" "$SRC/config.exemplo.json" "$DIR/"
rm -rf "$TMP"
cd "$DIR"
npm install --omit=dev --no-audit --no-fund --loglevel=error

umask 077
printf 'SERVER_KEY=%s\nPASTA_SESSOES=%s/sessoes\n' "$CHAVE" "$DIR" > "$DIR/.env"
umask 022

cat > /etc/systemd/system/adm-conector.service <<UNIT
[Unit]
Description=WhatsApp na nuvem (ADM Óticas)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=$(command -v node) $DIR/src/servidor.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable adm-conector >/dev/null 2>&1
systemctl restart adm-conector
sleep 3
echo
if systemctl is-active --quiet adm-conector; then
  echo "PRONTO! O WhatsApp na nuvem está funcionando."
  echo "Agora volte ao sistema, ligue o 'WhatsApp na nuvem' e leia o QR Code."
  echo "Para ver o que está acontecendo:  journalctl -u adm-conector -f"
else
  echo "Algo deu errado. Veja:  journalctl -u adm-conector -n 50"
fi
