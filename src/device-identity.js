import os from 'node:os';

export function assertTargetDevice(config,deviceId) {
  if(typeof deviceId!=='string'||deviceId!==config.deviceId)
    throw Object.assign(new Error('非法请求：设备名称不一致'),{status:403,code:'DEVICE_MISMATCH'});
}

export function deviceIdentity(config={}) {
  const deviceId=config.deviceId??newDeviceIdentity().deviceId;
  return {deviceId,deviceName:config.deviceName??deviceId};
}

export function newDeviceIdentity(hostname=os.hostname()) {
  const deviceId=hostname.replace(/\.local$/i,'').replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64)||'computer';
  return {deviceId,deviceName:deviceId};
}

export function migrateDeviceIdentity(saved) {
  const machine=newDeviceIdentity();
  const oldHost=os.hostname().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,30)||'computer';
  const oldPrefix=`local-${oldHost}-`;
  const generated=!saved.deviceId||saved.deviceId==='local-computer'||(saved.deviceId.startsWith(oldPrefix)&&/^[a-f0-9]{6}$/.test(saved.deviceId.slice(oldPrefix.length)));
  const deviceId=generated?machine.deviceId:saved.deviceId;
  const automaticName=!saved.deviceName||saved.deviceName===saved.deviceId||saved.deviceName===os.hostname().slice(0,80);
  return {deviceId,deviceName:automaticName?deviceId:saved.deviceName};
}

export function validateDeviceIdentity(config) {
  if(typeof config.deviceId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.deviceId))
    throw Object.assign(new Error('MCP 标识最多 64 位，只能包含字母、数字、短横线或下划线，不能以符号开头'),{status:400});
  if(typeof config.deviceName!=='string'||!config.deviceName.trim()||config.deviceName.length>80||/[\u0000-\u001f\u007f]/.test(config.deviceName))
    throw Object.assign(new Error('设备名称须为 1–80 个字符，可使用中文，不能包含换行或控制字符'),{status:400});
}

export function deviceInstructions(config) {
  const identity=deviceIdentity(config);
  return `This connection is ONLY for device ${JSON.stringify(identity.deviceName)} (MCP ID: ${identity.deviceId}); pass deviceId=${JSON.stringify(identity.deviceId)} in every call. With several devices connected, use the one the user named; if that is ambiguous, ask first. Do not silently fall back to another computer when this one is offline.`;
}
