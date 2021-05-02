// @ts-check
import { promises as fs } from 'fs';
import https from 'https';
import crypto from 'crypto';
import axios from 'axios';

const appinfos = {
  app_id: 'fr.niico.freebox',
  app_name: 'niico',
  app_version: '0.0.1',
  device_name: 'niico',
};

const log = (msg) => {
  const now = new Date().toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (typeof msg === 'string') {
    console.log(`[${now}] freebox - ${msg}`);
  } else {
    console.log(`[${now}] freebox - object`);
    console.log(msg);
  }
};

const init = async () => {
  try {
    if (!(await fs.stat('auth.json')).isFile()) return null;
    const content = await fs.readFile('auth.json', 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
};

const buildClient = async (baseURL) => {
  const httpsAgentConfig = { ca: await fs.readFile('freebox.pem', 'utf8') };

  const client = axios.create({
    baseURL,
    httpsAgent: new https.Agent(httpsAgentConfig),
    proxy: {
      host: '127.0.0.1',
      port: 8888,
    },
  });

  return client;
};

const getInfos = async () => {
  const response = await axios.get('http://mafreebox.freebox.fr/api_version');
  const { api_base_url, api_version } = response.data;
  const version = api_version.substring(0, api_version.indexOf('.'));
  const baseURL = `https://mafreebox.freebox.fr${api_base_url}v${version}/`;
  return baseURL;
};

const pair = async () => {
  const baseURL = await getInfos();
  const client = await buildClient(baseURL);
  const auth = await authorize(client);
  const data = { baseURL, auth };
  await fs.writeFile('auth.json', JSON.stringify(data), 'utf8');
  return data;
};

const authorize = async (client) => {
  let response = await client.post(`/login/authorize`, appinfos);
  if (!response.data.success) {
    throw new Error('authorize');
  }
  const { app_token, track_id } = response.data.result;

  log('Attente de la validation manuelle sur la freebox...');

  let status = 'pending';
  while (status === 'pending') {
    response = await client.get(`/login/authorize/${track_id}`);
    if (!response.data.success) throw new Error('authorize check');
    status = response.data.result.status;
  }

  if (status !== 'granted') throw new Error(`authorize status = ${status}`);

  const { password_salt } = response.data.result;
  return { app_token, password_salt };
};

const login = async (client, auth) => {
  const chdata = (await client.get('/login')).data;
  if (!chdata.success) throw new Error('login');
  const { challenge } = chdata.result;

  const password = crypto
    .createHmac('sha1', auth.app_token)
    .update(challenge)
    .digest('hex');

  const sedata = (
    await client.post('/login/session', {
      app_id: appinfos.app_id,
      password,
    })
  ).data;
  if (!sedata.success) throw new Error(`${sedata.error_code} - ${sedata.msg}`);

  // ajout du token dans les headers pour les prochains appels
  client.defaults.headers['X-Fbx-App-Auth'] = sedata.result.session_token;

  return sedata.result.session_token;
};

const getDevices = async (client) => {
  const response = await client.get('/lan/browser/pub');
  if (!response.data.success) throw new Error('get device');
  return response.data.result;
};

const getPlayers = async (client) => {
  const response = await client.get('/player');
  if (!response.data.success) throw new Error('get players');
  return response.data.result.map((p) => {
    const version = p.api_version.substring(0, p.api_version.indexOf('.'));
    p.baseUrl = `player/${p.id}/api/v${version}`;
    return p;
  });
};

const getPlayerState = async (client, player) => {
  const response = await client.get(`${player.baseUrl}/status`);
  if (!response.data.success) throw new Error('get player state');
  return response.data.result;
};

const playerLaunch = async (client, player, url) => {
  const response = await client.post(`${player.baseUrl}/control/open`, { url });
  if (!response.data.success) throw new Error('launch');
  log(response)
  return response.data.result;
};

(async () => {
  let infos = await init();
  if (!infos) {
    log('pairing avec la freebox...');
    infos = await pair();
    log('pairing ok');
  }
  const client = await buildClient(infos.baseURL);
  await login(client, infos.auth);
  log('logged in');

  // const devices = await getDevices(client);
  // const connected = devices.filter((d) => d.active);

  // log(`${devices.length} devices, ${connected.length} connectés.`);

  const players = await getPlayers(client);

  for (const player of players) {
    const state = await getPlayerState(client, player);
    log(state);
  }

  const player = players[0];
  await playerLaunch(client, player, 'app:com.netflix');

  log('done.')
})();
