/**
 * Downloader from Spyglass
 * MIT License
 * Copyright (c) 2019-2022 SPGoding
 * 
 * Modified by Crystall-ll3
 */
import { http, https } from 'follow-redirects'
import { promises as fsp } from 'fs'
import type { IncomingMessage } from 'http'
import path from 'path'
import type { Logger } from '../shared'
import { fileUtil, isEnoent } from './fileUtil'

type RemoteProtocol = 'http:' | 'https:'
export type RemoteUriString = `${RemoteProtocol}${string}`
export namespace RemoteUriString {
	export function getProtocol(uri: RemoteUriString): RemoteProtocol {
		return uri.slice(0, uri.indexOf(':') + 1) as RemoteProtocol
	}
}

export class Downloader {
	constructor(
		private readonly cacheRoot: string,
		private readonly logger: Logger,
		private readonly lld = LowLevelDownloader.create(),
	) { }

	async getCacheOrRefreshDownload<R>(job: Job<R>, checksumJob: Job<string>): Promise<R | undefined> {
		const { remoteUri, localFileUri, codec } = job
		const { remoteUri: checksumRemoteUri, localFileUri: checksumLocalFileUri, codec: checksumCodec } = checksumJob

		this.logger.info(`[Downloader] [${localFileUri}] Tring to check "${checksumRemoteUri}"`)

		const remoteChecksum = await this.dowload(checksumJob)
		if (remoteChecksum) {
			const cachedChecksum = await this.loadCache(checksumLocalFileUri, checksumCodec)
			if (remoteChecksum === cachedChecksum) {
				return await this.getCachedOrDownloadCache(job)
			} else {
				this.logger.info(`[Downloader] [${localFileUri}] Checksum mismatch, refreshing cache`)
				await this.deleteCache(localFileUri)
				await this.saveCache(checksumLocalFileUri, Buffer.from(remoteChecksum), checksumCodec)
			}
		} else {
			this.logger.info(`[Downloader] [${localFileUri}] Checksum check failed, falling back to cached download`)
		}

		return await this.getCachedOrDownloadCache(job)
	}

	async getCachedOrDownloadCache<R>(job: Job<R>): Promise<R | undefined> {
		const { remoteUri: uri, optionsRemoteUri: optionsUri, localFileUri, codec } = job

		const file = await this.loadCache(localFileUri, codec)
		if (file) {
			return file
		}

		this.logger.info(`[Downloader] [${localFileUri}] Trying to dowload "${uri}"`)

		try {
			const buffer = await this.lld.get(uri, optionsUri)
			this.logger.info(`[Downloader] [${localFileUri}] Downloaded from "${uri}"`)
			if (buffer) {
				this.saveCache(localFileUri, buffer, codec) 
			}
			return await codec.constructor(buffer)
		} catch (err) {
			this.logger.error(`[Downloader] [${localFileUri}] Download failed: \n `, err)
		}

		this.logger.error(`[Downloader] [${localFileUri}] Failed, returning empty`)

		return undefined
	}

	async dowload<R>(job: Job<R>): Promise<R | undefined> {
		const { remoteUri: uri, optionsRemoteUri: optionsUri, localFileUri, codec } = job

		this.logger.info(`[Downloader] [${localFileUri}] Trying to dowload "${uri}"`)

		try {
			const buffer = await this.lld.get(uri, optionsUri)
			this.logger.info(`[Downloader] [${localFileUri}] Downloaded from "${uri}"`)
			return await codec.constructor(buffer)
		} catch (err) {
			this.logger.error(`[Downloader] [${localFileUri}] Download failed: \n `, err)
		}

		this.logger.error(`[Downloader] [${localFileUri}] Failed, returning empty`)

		return undefined
	}

	private async loadCache<R>(localFileUri: string, codec: Codec<R>): Promise<R | undefined> {
		const cacheFilePath = path.join(this.cacheRoot, localFileUri)
		try {
			const cachedBuffer = await fileUtil.readFile(fileUtil.pathToFileUri(cacheFilePath))
			const deserializer = codec.deserializer ?? (b => b)
			const ans = await codec.constructor(await deserializer(cachedBuffer))
			this.logger.info(`[Downloader] [${localFileUri}] Skipped downloading thanks to cache`)
			return ans
		} catch (e) {
			if (!isEnoent(e)) {
				this.logger.error(`[Downloader] [${localFileUri}] Failed to load cache file "${cacheFilePath}": \n `, e)
				try {
					await fsp.unlink(cacheFilePath)
					this.logger.info(`[Downloader] [${localFileUri}] Removed the invalid cache file`)
				} catch (e) {
					this.logger.error(`[Downloader] [${localFileUri}] Failed to remove the invalid cache file: \n `, e)
				}
			} else {
				this.logger.error(`[Downloader] [${localFileUri}] Cache file does not exist`)
			}
		}

		return undefined
	}
	
	private async saveCache<R>(localFileUri: string, toSave: Buffer, codec: Codec<R>) {
		const cacheFilePath = path.join(this.cacheRoot, localFileUri)
		try {
			const serializer = codec.serializer ?? (b => b)
			await fileUtil.writeFile(fileUtil.pathToFileUri(cacheFilePath), await serializer(toSave))
			this.logger.info(`[Downloader] [${localFileUri}] New cached file saved`)
		} catch (e) {
			this.logger.error(`[Downloader] [${localFileUri}] Failed to save the cache file "${localFileUri}": \n `, e)
		}
	}

	private async deleteCache<R>(localFileUri: string) {
		const cacheFilePath = path.join(this.cacheRoot, localFileUri)
		try {
			await fsp.unlink(cacheFilePath)
			this.logger.error(`[Downloader] [${localFileUri}] Deleted`)
		} catch (e) {
			if (!isEnoent(e)) {
				this.logger.error(`[Downloader] [${localFileUri}] Failed to delete cache file "${cacheFilePath}": \n `, e)
			} else {
				this.logger.error(`[Downloader] [${localFileUri}] Cache file does not exist`)
			}
		}
	}
}

export interface Job<R> {
	remoteUri: RemoteUriString,
	optionsRemoteUri?: LowLevelDownloadOptions,
	/**
	 * A unique ID in a local cache. 
	 * Unique ID storage path: '~/vscode-worldgen-tools/Cache/@var localFileUri'
	 */
	localFileUri: string,
	codec: Codec<R>
}
export interface Codec<R> {
	/**
	 * A serializer for cache files
	 */
	serializer?: (data: Buffer) => Buffer | Promise<Buffer>,
	/**
	 * A deserializer for cached files
	 */
	deserializer?: (cache: Buffer) => Buffer | Promise<Buffer>,
	/**
	 * A final transformation for downloaded or cache files
	 */
	constructor: (data: Buffer) => PromiseLike<R> | R
}

interface LowLevelDownloadOptions {
	/**
	 * Use an string array to set multiple values to the header.
	 */
	headers?: Record<string, string | string[]>
    timeout?: number;
    /**
     * @default 8192
     */
    maxHeaderSize?: number;
}

export interface LowLevelDownloader {
	/**
	 * @throws
	 */
	get(uri: RemoteUriString, options?: LowLevelDownloadOptions): Promise<Buffer>
}

export namespace LowLevelDownloader {
	export function create(): LowLevelDownloader {
		return new LowLevelDownloaderImpl()
	}
	export function mock(options: LowLevelDownloaderMockOptions): LowLevelDownloader {
		return new LowLevelDownloaderMock(options)
	}
}

class LowLevelDownloaderImpl implements LowLevelDownloader {
	get(uri: RemoteUriString, options: LowLevelDownloadOptions = {}): Promise<Buffer> {
		const protocol = RemoteUriString.getProtocol(uri)
		
		return new Promise<Buffer>((resolve, reject) => {
			const callback = (res: IncomingMessage) => {
			  	let data = ''
				res.on('data', (chunk) => {
			    	data += chunk
			  	})
			  	res.on('end', () => {
					resolve(Buffer.from(data))
			  	})
			}

			const req = protocol === 'http:' ? http.get(uri, options, callback) : https.get(uri, options, callback)

			req.on('error' , (err: Error) => {
				reject(err);
			})
		})
	}
}

interface LowLevelDownloaderMockOptions {
	/**
	 * A record from URIs to fixture data. The {@link LowLevelDownloader.get} only returns a {@link Buffer},
	 * therefore `string` fixtures will be turned into a `Buffer` and `object` fixtures will be transformed
	 * into JSON and then turned into a `Buffer`.
	 */
	fixtures: Record<RemoteUriString, string | Buffer | object>,
}

class LowLevelDownloaderMock implements LowLevelDownloader {
	constructor(private readonly options: LowLevelDownloaderMockOptions) { }

	async get(uri: RemoteUriString): Promise<Buffer> {
		if (!this.options.fixtures[uri]) {
			throw new Error(`404 not found: ${uri}`)
		}
		const fixture = this.options.fixtures[uri]
		if (Buffer.isBuffer(fixture)) {
			return fixture
		} else if (typeof fixture === 'string') {
			return Buffer.from(fixture, 'utf-8')
		} else {
			return Buffer.from(JSON.stringify(fixture), 'utf-8')
		}
	}
}
function pathToFileUri(pathToFileUri: any) {
	throw new Error('Function not implemented.')
}
