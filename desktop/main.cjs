const { app, BrowserWindow, session, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
let service;
app.setName('ChatGPT Science');
app.setAppUserModelId('local.chatgpt.science.independent');
const dataHome=process.env.SCIENCE_DATA_HOME || path.join(process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged?path.dirname(process.execPath):app.getAppPath()),'ChatGPTScienceData');
fs.mkdirSync(dataHome,{recursive:true});
for(const name of ['browser-profile','browser-cache'])fs.mkdirSync(path.join(dataHome,name),{recursive:true});
app.setPath('userData',path.join(dataHome,'browser-profile'));
app.setPath('sessionData',path.join(dataHome,'browser-cache'));
const acquired = app.requestSingleInstanceLock();
if (!acquired) app.quit();
let window;
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.whenReady().then(async () => {
  if(!acquired)return;
  const runtimeRoot=app.isPackaged?path.join(process.resourcesPath,'runtime'):path.join(app.getAppPath(),'.runtime');
  process.env.SCIENCE_RUNTIME_DIR=runtimeRoot;
  process.env.SCIENCE_WORKER_DIR=app.isPackaged?path.join(process.resourcesPath,'app.asar.unpacked','worker'):path.join(app.getAppPath(),'worker');
  // The reference interface is an external asset that must be supplied locally and is not
  // part of this application. Opt in with SCIENCE_REFERENCE_UI=1; otherwise this app serves
  // its own interface, which is what keeps it independent of any other vendor's build.
  const useReferenceUi = process.env.SCIENCE_REFERENCE_UI === '1';
  const { startServer } = await import('../server/index.mjs');
  const {defaultPythonPath}=await import('../server/kernel-client.mjs');
  service = await startServer({ dataRoot: path.join(dataHome, 'research-data'), referenceUi:useReferenceUi, pythonPath: process.env.SCIENCE_PYTHON_PATH || defaultPythonPath(runtimeRoot) });
  fs.writeFileSync(path.join(dataHome,'running.json'),JSON.stringify({app:'ChatGPT Science',pid:process.pid,origin:service.origin,startedAt:new Date().toISOString()},null,2));
  await session.defaultSession.cookies.set({url:service.origin,name:'science_session',value:service.token,httpOnly:true,sameSite:'strict',path:'/'});
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'notifications'));
  window = new BrowserWindow({ width: 1480, height: 940, minWidth: 980, minHeight: 640, backgroundColor:'#faf9f6', title:'ChatGPT Science', autoHideMenuBar:true, show:true, webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true} });
  window.webContents.on('page-title-updated',event=>{event.preventDefault();window.setTitle('ChatGPT Science');});
  window.webContents.setWindowOpenHandler(({url}) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); return {action:'deny'}; });
  window.webContents.on('will-navigate', (event,url) => { if (!url.startsWith(service.origin+'/')) {event.preventDefault();if(/^https:\/\//.test(url))void shell.openExternal(url);} });
  await window.loadURL(service.origin + (useReferenceUi ? '/reference/' : '/'));
  window.show();
}).catch(error=>{dialog.showErrorBox('ChatGPT Science 啟動失敗',error.message);app.quit();});
app.on('window-all-closed',()=>app.quit());
let quitting=false;
app.on('before-quit',event=>{if(service&&!quitting){event.preventDefault();quitting=true;service.close().finally(()=>app.quit());}});
