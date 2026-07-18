/**
 * 远端网页网关模块 barrel。
 *
 * 历史形态：单文件 ~1000 行；为便于维护拆为
 * electron/ipc/remote-gateway/{config,shellServe,multipart,auth,router,index}.ts。
 * 旧路径 './remote-gateway' 与新路径 './remote-gateway/index' 都可用。
 */
export type { RemoteGatewayFileConfig } from './remote-gateway/config';
export { mergeRemoteGatewayPatch } from './remote-gateway/config';

export {
  pickRemoteStandaloneAsset,
  publicRemoteGatewayGet,
  mimeForPath,
  assertRemoteFileAccess,
} from './remote-gateway/shellServe';

export {
  parseMultipartFiles,
  normalizeRemoteRequestPathname,
  BODY_JSON_CAP,
  BODY_UPLOAD_CAP,
} from './remote-gateway/multipart';

export { authorize } from './remote-gateway/auth';

export {
  attachRemoteGatewayMainWindow,
  bootstrapRemoteGatewayFromDisk,
} from './remote-gateway/index';

export { applyRemoteGatewayListening } from './remote-gateway/router';