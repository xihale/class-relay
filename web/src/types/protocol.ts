export type Role = 'recv' | 'send';
export type TransportKind = 'ws' | 'sse' | 'poll';
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'error';
export type RedirectStatus = 'idle' | 'navigating' | 'awaiting-focus' | 'blocked' | 'done';

export interface RoomPeers {
  total: number;
  recv: number;
  send: number;
}

export interface RoomReceipts {
  delivered: number;
  jumped: number;
}

export interface RelayItem {
  seq: number;
  room: string;
  url: string;
  source: string;
  host: string;
  createdAt: number;
  expiresAt: number;
  expiresAtLocal: number;
}

export interface RelaySnapshot {
  room: string;
  seq: number;
  active: boolean;
  url?: string;
  source?: string;
  host?: string;
  createdAt?: number;
  expiresAt?: number;
  serverTime: number;
  peers?: RoomPeers;
  receipts?: RoomReceipts;
}

export interface Preset {
  id: string;
  name: string;
  hint: string;
  url: string;
}

export type WarmedMap = Record<string, number>;

export interface DecodeProgress {
  step: number;
  total: number;
  label: string;
}

export interface ScannerSupport {
  camera: boolean;
  barcodeDetector: boolean;
  wasmWorker: boolean;
}

export interface ZoomInfo {
  supported: boolean;
  min: number;
  max: number;
  step: number;
  value: number;
  digitalZoom: number;
  isDigital: boolean;
}

export interface TorchInfo {
  supported: boolean;
  active: boolean;
}
