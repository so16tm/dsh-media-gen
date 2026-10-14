/**
 * Storage: the part of DSH's storage-domain service this plugin uses. Domain
 * specs are declared structurally so the plugin needs no runtime dependency
 * on the storage packages; DSH validates every record with the spec's
 * `parse` when a domain opens.
 * @module dsh-media-gen/src/storage
 */
/**
 * Open a domain, retrying while a previous instance of this plugin is still
 * closing it after a reload.
 */
export async function openDomain(service, spec, attempts = 10, delayMs = 200) {
    for (let attempt = 1;; attempt++) {
        try {
            return await service.open(spec);
        }
        catch (error) {
            const code = typeof error === 'object' && error !== null ? error.code : undefined;
            if (code !== 'already-open' || attempt >= attempts)
                throw error;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}
