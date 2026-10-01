import { featureHttp } from '$lib/core/feature-http';
import type { BrowserStatus } from './types';

export interface BrowserApi {
	status(): Promise<BrowserStatus>;
	takeOver(): Promise<BrowserStatus>;
	handBack(): Promise<BrowserStatus>;
}

const http = featureHttp("The browser isn't available yet.");

export const httpBrowserApi: BrowserApi = {
	status: () => http.get('/browser'),
	takeOver: () => http.post('/browser/takeover'),
	handBack: () => http.post('/browser/handback')
};
