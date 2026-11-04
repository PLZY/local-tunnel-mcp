import {deviceIdentity,validateDeviceIdentity} from './device-identity.js';

// These values contain the user's token. Only return them from an explicit, local POST action.
export function connectionBundle({remoteUrl,config},token){
  const identity=deviceIdentity(config);
  validateDeviceIdentity(identity);
  const {deviceId}=identity;
  const url=remoteUrl+'/mcp';
  const entry={type:'http',url,headers:{Authorization:'Bearer '+token,'X-Device-Id':deviceId}};
  return {
    ...identity,
    url,
    generic:JSON.stringify({mcpServers:{[deviceId]:entry}},null,2),
  };
}
