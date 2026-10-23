import fs from 'node:fs';
import path from 'node:path';
import { home, readJson, writeJson } from './files.js';
import { identityAlive, signalProcess } from './process-identity.js';
import { transaction } from './database.js';

// Removal only: no Telegram client, token use or outbound communication.
export async function retireTelegram() {
  const runtimeFile = path.join(home(), 'runtime', 'telegram.json'), info = readJson(runtimeFile, null);
  if (info?.identity && identityAlive(info.identity)) {
    signalProcess(info.identity, 'SIGTERM');
    for (let i = 0; i < 40 && identityAlive(info.identity); i++) await new Promise(resolve => setTimeout(resolve, 50));
    if (identityAlive(info.identity)) signalProcess(info.identity, 'SIGKILL');
    if (identityAlive(info.identity)) throw new Error('The retired chat bridge is still stopping. Retry in a moment.');
  }
  fs.rmSync(runtimeFile, { force: true });
  const configFile = path.join(home(), 'config.json'), config = readJson(configFile, null);
  if (config?.notifications && Object.hasOwn(config.notifications, 'telegram')) {
    delete config.notifications.telegram; writeJson(configFile, config);
  }
  const credentialFile = path.join(home(), 'credentials.json'), credentials = readJson(credentialFile, null);
  if (credentials && Object.hasOwn(credentials, 'telegramBotToken')) {
    delete credentials.telegramBotToken; writeJson(credentialFile, credentials);
  }
  if (fs.existsSync(path.join(home(), 'bzzy.sqlite'))) {
    transaction(db => { db.prepare("DELETE FROM records WHERE kind GLOB 'telegram-*'").run(); });
  }
}
