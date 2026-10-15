#!/bin/sh
# 为本地容器生成开发用证书；已有 TLS 目录绝不覆盖。
set -eu
umask 077
deployment_root=${1:-.}
mkdir -p -- "$deployment_root/workspace" "$deployment_root/app-data"
chmod 0700 -- "$deployment_root/app-data"
if [ -e "$deployment_root/app-data/tls" ]; then
  if [ -f "$deployment_root/app-data/tls/server.crt" ] && [ -f "$deployment_root/app-data/tls/server.key" ]; then
    echo '已有 TLS 证书，保持原样。'
    exit 0
  fi
  echo 'TLS 目录已存在但证书不完整，请人工检查；不会覆盖。' >&2
  exit 1
fi
tls_temporary=$(mktemp -d -- "$deployment_root/app-data/.tls-XXXXXX")
trap 'if [ -d "$tls_temporary" ]; then python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$tls_temporary"; fi' EXIT HUP INT TERM
openssl req -x509 -newkey rsa:2048 -noenc -sha256 -days 30 \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1' \
  -keyout "$tls_temporary/server.key" -out "$tls_temporary/server.crt"
mv -T -n -- "$tls_temporary" "$deployment_root/app-data/tls"
if [ -d "$tls_temporary" ]; then
  echo '另一个进程创建了 TLS 目录，本次未覆盖。' >&2
  exit 1
fi
echo '已创建 30 天有效的本地自签名证书。浏览器需要信任该证书；公网请使用受信任证书或外部 HTTPS 代理。'
