#!/bin/bash
mkdir -p ~/dss/apps/jewkiebot/engines/stockfish
wget -qO- https://github.com/official-stockfish/Stockfish/releases/latest/download/stockfish-ubuntu-x86-64-avx2.tar | tar x --strip-components=1 -C ~/dss/apps/jewkiebot/engines/stockfish/
mv ~/dss/apps/jewkiebot/engines/stockfish/stockfish-ubuntu-x86-64-avx2 ~/dss/apps/jewkiebot/engines/stockfish/stockfish 2>/dev/null || true

mkdir -p ~/dss/apps/jewkiebot/engines/berserk
wget -qO- https://github.com/jhonnold/berserk/releases/download/13/berserk-13-linux-x86-64.tar.gz | tar xz -C ~/dss/apps/jewkiebot/engines/berserk/
mv ~/dss/apps/jewkiebot/engines/berserk/berserk* ~/dss/apps/jewkiebot/engines/berserk/berserk 2>/dev/null || true
chmod +x ~/dss/apps/jewkiebot/engines/berserk/berserk

mkdir -p ~/dss/apps/jewkiebot/engines/clover
wget -qO- https://github.com/lucametehau/CloverEngine/releases/download/v6.1/Clover-6.1-x86_64-linux.tar.gz | tar xz -C ~/dss/apps/jewkiebot/engines/clover/
mv ~/dss/apps/jewkiebot/engines/clover/Clover* ~/dss/apps/jewkiebot/engines/clover/clover 2>/dev/null || true
chmod +x ~/dss/apps/jewkiebot/engines/clover/clover

mkdir -p ~/dss/apps/jewkiebot/engines/igel
wget -qO igel.zip https://github.com/vshcherbyna/igel/releases/download/3.5.0/igel-3.5.0-linux-x86_64.zip
unzip -o igel.zip -d ~/dss/apps/jewkiebot/engines/igel/
mv ~/dss/apps/jewkiebot/engines/igel/igel* ~/dss/apps/jewkiebot/engines/igel/igel 2>/dev/null || true
rm igel.zip
chmod +x ~/dss/apps/jewkiebot/engines/igel/igel

mkdir -p ~/dss/apps/jewkiebot/engines/rubichess
wget -qO rubi.zip https://github.com/Matthies/RubiChess/releases/download/v2.4/RubiChess-2.4-linux-x86_64.zip
unzip -o rubi.zip -d ~/dss/apps/jewkiebot/engines/rubichess/
mv ~/dss/apps/jewkiebot/engines/rubichess/RubiChess* ~/dss/apps/jewkiebot/engines/rubichess/rubichess 2>/dev/null || true
rm rubi.zip
chmod +x ~/dss/apps/jewkiebot/engines/rubichess/rubichess

echo "Engines downloaded!"
