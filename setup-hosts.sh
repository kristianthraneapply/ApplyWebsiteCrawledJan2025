#!/bin/bash

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo "Please run as root (use sudo)"
  exit 1
fi

# Add domain mappings
echo "127.0.0.1 apply.agency" >> /etc/hosts
echo "127.0.0.1 www.apply.agency" >> /etc/hosts
echo "127.0.0.1 cdn.prod.website-files.com" >> /etc/hosts
echo "127.0.0.1 assets.website-files.com" >> /etc/hosts
echo "127.0.0.1 uploads-ssl.webflow.com" >> /etc/hosts
echo "127.0.0.1 d3e54v103j8qbb.cloudfront.net" >> /etc/hosts

# Flush DNS cache
if [[ "$OSTYPE" == "darwin"* ]]; then
  dscacheutil -flushcache
  killall -HUP mDNSResponder
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  systemctl restart systemd-resolved
fi

echo "Domain mappings added and DNS cache flushed" 