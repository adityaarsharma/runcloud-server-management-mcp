#!/usr/bin/env bash
# Perch — One-liner quick status
MEM=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')
DISK=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
LOAD=$(uptime | awk -F'load average:' '{print $2}' | awk '{print $1}' | tr -d ',')
NSVC=$(systemctl list-units --all 2>/dev/null | grep -q 'nginx-rc' && echo nginx-rc || echo nginx)
NGINX=$(systemctl is-active "$NSVC" 2>/dev/null)
MYSQL=$(systemctl is-active mysql 2>/dev/null || systemctl is-active mariadb 2>/dev/null || echo off)

echo "RAM ${MEM}% | Disk ${DISK}% | Load ${LOAD} | ${NSVC}: ${NGINX} | MySQL: ${MYSQL}"
