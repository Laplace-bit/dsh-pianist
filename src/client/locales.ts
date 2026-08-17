/** Locale dictionaries owned by the dsh-pianist settings card. */

export const NS = 'settings.pianist';

export type PianistLocaleKey =
  | 'title' | 'description'
  | 'enabled' | 'enabledHint'
  | 'renderMode' | 'renderModeImmersive' | 'renderModeEmbedded' | 'returnToEmbeddedOnEnd'
  | 'skin' | 'skinPreview'
  | 'visualQuality' | 'volume'
  | 'showWaterfall'
  | 'events' | 'eventNotes' | 'eventPedal' | 'eventTempo' | 'eventParticles'
  | 'qualityLow' | 'qualityMedium' | 'qualityHigh'
  | 'loading' | 'unavailable' | 'retry' | 'readOnly'
  | 'version' | 'developmentVersion'
  | 'updates' | 'updateHint' | 'developmentBuild' | 'updateUnavailable'
  | 'update' | 'updating' | 'restartRequired' | 'repairRequired' | 'updateFailed'
  | 'save' | 'saving' | 'saved' | 'discard' | 'unsaved' | 'saveFailed'
  | 'playerPreparing' | 'playerStreaming' | 'playerUnavailable' | 'playerNotes'
  | 'playerPlay' | 'playerPause' | 'playerStop' | 'playerSeek'
  | 'playerRate' | 'playerFullscreen' | 'playerAudioBlocked'
  | 'playerImmersive' | 'playerReturnEmbedded' | 'playerClose';

export const en: Record<PianistLocaleKey, string> = {
  title: 'Pianist',
  description: 'Piano playback, visuals, and performance events.',
  enabled: 'Enable piano performance',
  enabledHint: 'Turns off piano audio and visuals without removing your settings.',
  renderMode: 'Render mode',
  renderModeImmersive: 'Immersive',
  renderModeEmbedded: 'In chat',
  returnToEmbeddedOnEnd: 'Return to the chat player when the piece ends',
  skin: 'Skin',
  skinPreview: 'Preview',
  visualQuality: 'Visual quality',
  volume: 'Volume',
  showWaterfall: 'Show note waterfall',
  events: 'Performance events',
  eventNotes: 'Notes',
  eventPedal: 'Pedal',
  eventTempo: 'Tempo',
  eventParticles: 'Particles',
  qualityLow: 'Low',
  qualityMedium: 'Medium',
  qualityHigh: 'High',
  loading: 'Loading plugin settings...',
  unavailable: 'Plugin settings are unavailable in this connection.',
  retry: 'Retry',
  readOnly: 'This deployment stores settings read-only.',
  version: 'Version {version}',
  developmentVersion: 'Development version {version}',
  updates: 'Updates',
  updateHint: 'Install the newest compatible package version, then restart Harness.',
  developmentBuild: 'Linked or file-based source; manage updates from the checkout.',
  updateUnavailable: 'Updates are available only for a registry package in the active profile.',
  update: 'Update',
  updating: 'Updating...',
  restartRequired: 'Updated. Restart Harness to load the new version.',
  repairRequired: 'The package was updated, but its plugin bundle needs repair. Retry the update before restarting.',
  updateFailed: 'The package update failed. Your current profile settings were not changed.',
  save: 'Save',
  saving: 'Saving...',
  saved: 'Saved.',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  playerPreparing: 'Preparing piano performance...',
  playerStreaming: 'receiving score',
  playerUnavailable: 'This piano performance is unavailable or invalid.',
  playerNotes: 'notes',
  playerPlay: 'Play',
  playerPause: 'Pause',
  playerStop: 'Stop',
  playerSeek: 'Seek',
  playerRate: 'Playback rate',
  playerFullscreen: 'Fullscreen',
  playerAudioBlocked: 'Browser audio is waiting for a user gesture. Press Play to continue.',
  playerImmersive: 'Immersive',
  playerReturnEmbedded: 'Return to chat',
  playerClose: 'Close',
};

export const zh: Record<PianistLocaleKey, string> = {
  title: '钢琴演奏',
  description: '钢琴播放、视觉效果和演奏事件。',
  enabled: '启用钢琴演奏',
  enabledHint: '关闭后不会移除已有配置，只会停用钢琴音频和视觉效果。',
  renderMode: '渲染模式',
  renderModeImmersive: '沉浸式',
  renderModeEmbedded: '嵌入聊天',
  returnToEmbeddedOnEnd: '演奏结束时自动回到聊天播放器',
  skin: '皮肤',
  skinPreview: '预览',
  visualQuality: '视觉质量',
  volume: '音量',
  showWaterfall: '显示音符瀑布',
  events: '演奏事件',
  eventNotes: '音符',
  eventPedal: '踏板',
  eventTempo: '速度',
  eventParticles: '粒子效果',
  qualityLow: '低',
  qualityMedium: '中',
  qualityHigh: '高',
  loading: '正在加载插件设置...',
  unavailable: '当前连接无法访问插件设置。',
  retry: '重试',
  readOnly: '此部署中的设置为只读。',
  version: '版本 {version}',
  developmentVersion: '开发版本 {version}',
  updates: '更新',
  updateHint: '安装最新兼容包版本后重启 Harness。',
  developmentBuild: '当前为链接或 file 本地源码，请在源码目录管理更新。',
  updateUnavailable: '只有 active profile 中的 registry 包可以更新。',
  update: '更新',
  updating: '更新中...',
  restartRequired: '已更新；重启 Harness 后加载新版本。',
  repairRequired: '包已更新，但插件 bundle 尚需修复。请先重试更新，再重启。',
  updateFailed: '包更新失败，当前 profile 设置没有变化。',
  save: '保存',
  saving: '保存中...',
  saved: '已保存。',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '部署没有接受这些值，已保留供你修正。',
  playerPreparing: '正在准备钢琴演奏...',
  playerStreaming: '乐谱生成中',
  playerUnavailable: '此钢琴演奏不可用或乐谱无效。',
  playerNotes: '个音符',
  playerPlay: '播放',
  playerPause: '暂停',
  playerStop: '停止',
  playerSeek: '定位进度',
  playerRate: '播放速度',
  playerFullscreen: '全屏',
  playerAudioBlocked: '浏览器正在等待用户手势，请点击播放继续。',
  playerImmersive: '沉浸式',
  playerReturnEmbedded: '返回聊天',
  playerClose: '关闭',
};

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.pianist': PianistLocaleKey;
  }
}
