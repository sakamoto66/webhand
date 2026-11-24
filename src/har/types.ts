/** HAR 1.2 data model and Chrome DevTools Protocol Network.* event types. */

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface HarQueryParam {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType: string;
  text: string;
  params?: { name: string; value: string }[];
}

interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: "base64";
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarHeader[];
    queryString: HarQueryParam[];
    postData?: HarPostData;
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarHeader[];
    content: HarContent;
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
}

export interface HarDocument {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    browser?: { name: string; version: string };
    entries: HarEntry[];
  };
}

interface CdpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
}

export interface CdpResponse {
  url?: string;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  mimeType?: string;
  protocol?: string;
}

export interface CdpRequestWillBeSent {
  requestId: string;
  request: CdpRequest;
  timestamp: number;
  wallTime?: number;
  redirectResponse?: CdpResponse;
}

export interface CdpRequestExtraInfo {
  requestId: string;
  headers?: Record<string, string>;
}

export interface CdpResponseReceived {
  requestId: string;
  timestamp: number;
  response: CdpResponse;
}

export interface CdpResponseExtraInfo {
  requestId: string;
  headers?: Record<string, string>;
  statusCode?: number;
}

export interface CdpLoadingFinished {
  requestId: string;
  timestamp: number;
  encodedDataLength?: number;
}

export interface CdpLoadingFailed {
  requestId: string;
  timestamp: number;
}
