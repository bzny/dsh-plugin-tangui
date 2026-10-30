// Compatibility stub for imports retained by an older DSH session.
// The video-enabled implementation is preserved in archive/video-enabled-20261030.
// This edition never reads local media files or starts video requests.
import { fail } from './runtime-api.js';
const disabled = () => fail('video_disabled', '当前图文版不提供视频操作；旧视频数据保留。', 410);
export const MAX_CONTEXT_PAGES = 0;
export class MediaClient {
  constructor() {}
  policy() { return Promise.reject(disabled()); }
  upload() { return this.policy(); }
  context() { return this.policy(); }
  helper() { return this.policy(); }
  submit() { return this.policy(); }
}
export async function readVideoContext() { throw disabled(); }
export async function readPostVideos() { throw disabled(); }
