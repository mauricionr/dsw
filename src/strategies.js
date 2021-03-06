
let DSWManager;
let cacheManager;
let goFetch;

import utils from './utils.js';

// this function execute tasks that doesn take the
// strategy in concideration
function common (rule, request, event, matching) {
    if (rule.action.bundle) {
        DSWManager.traceStep(
            event.request,
            'Will load and cache bundle in background',
            { bundle: rule.action.bundle }
        );
        cacheManager.addAll(rule.action.bundle)
            .then(result=>{
                // the trace data here may not appear in the trace data once
                // it is been loaded in background. The request is **NOT** waiting
                // for the whole bundle to load.
                DSWManager.traceStep(
                    event.request,
                    'Bundle loaded and cached in background',
                    { bundle: rule.action.bundle }
                );
            })
            .catch(err=>{
                // same situation as the previous comment, here
                DSWManager.traceStep(
                    event.request,
                    'Could not load and cache bundle',
                    { bundle: rule.action.bundle }
                );
                console.warn('Could not load and cache all the bundle files', err.message || err);
            });
    }
}

const strategies = {
    // stores the DSWManager and CacheManager instances, and goFetch utility
    setup: function (dswM, cacheM, gf) {
        DSWManager = dswM;
        cacheManager = cacheM;
        goFetch = gf;
    },
    'offline-first': function offlineFirstStrategy (rule, request, event, matching) {
        // let's see if there is some action needed to run, no matter the strategy
        common(rule, request, event, matching);
        // add a trace step
        DSWManager.traceStep(
            event.request,
            'Info: Using offline first strategy',
            { url:request.url }
        );

        // Look for the content in cache. If it is not there, will fetch it,
        // then return it to be used and in the end, stores it in the cache
        return cacheManager.get(
            rule,
            request,
            event,
            matching
        );
    },
    'online-first': function onlineFirstStrategy (rule, request, event, matching) {
        // let's see if there is some action needed to run, no matter the strategy
        common(rule, request, event, matching);

        // stores the trace data
        DSWManager.traceStep(event.request, 'Info: Using online first strategy', { url:request.url });

        // Will fetch it, and if there is a problem
        // will look for it in cache
        function treatIt (response) {
            if (response.status == 200) {
                if (rule.action.cache) {
                    // we will update the cache, in background
                    cacheManager.put(rule, request, response).then(_=>{
                        DSWManager.traceStep(event.request, 'Updated cache');
                    });
                }
                return response;
            }
            return cacheManager.get(rule, request, event, matching)
                .then(result=>{
                    // if failed to fetch and was not in cache, we look
                    // for a fallback response
                    const pathName = (new URL(event.request.url)).pathname;
                    return result || DSWManager.treatBadPage(response, pathName, event);
                });
        }

        // if browser is offline, there is no need to try the request
        if (utils.DSW.isOffline()) {
            return treatIt(new Response('', {
                status: 404,
                statusText: 'Browser is offline',
                headers: {
                    'Content-Type' : 'text/plain'
                }
            }));
        }

        // time to go...fetch
        return goFetch(rule, request, event, matching)
            .then(treatIt)
            .catch(treatIt);
    },
    'fastest': function fastestStrategy (rule, request, event, matching) {
        // let's see if there is some action needed to run, no matter the strategy
        common(rule, request, event, matching);

        // stores the trace data
        DSWManager.traceStep(
            event.request,
            'Info: Using fastest strategy',
            { url:request.url }
        );

        // Will fetch AND look in the cache.
        // The cached data will be returned faster
        // but once the fetch request returns, it updates
        // what is in the cache (keeping it up to date)
        const pathName = (new URL(event.request.url)).pathname;
        let networkTreated = false,
            cacheTreated = false,
            networkFailed = false,
            cacheFailed = false;

        // fetch at the same time from the network and from cache
        // in fail function, verify if it failed for both, then treatBadRequest
        // in success, the first to have a 200 response, resolves it
        return new Promise((resolve, reject)=>{
            function treatFetch (response) {
                let result;

                // firstly, let's asure we update the cache, if needed
                if (response && response.status == 200) {
                    // if we managed to load it from network and it has
                    // cache in its actions, we cache it
                    if (rule.action.cache) {
                        // we will update the cache, in background
                        cacheManager.put(rule, request, response).then(_=>{
                            DSWManager.traceStep(event.request, 'Updated cache');
                        });
                    }
                }

                // if cache has not resolved it yet
                if (!cacheTreated) {
                    // if it downloaded well, we use it (probably the first access)
                    if (response.status == 200) {
                        networkTreated = true;
                        // if cache could not resolve it, the network resolves
                        DSWManager.traceStep(event.request, 'Fastest strategy resolved from network', {
                            url: response.url || request.url
                        });
                        resolve(response);
                    } else {
                        // if it failed, we will try and respond with
                        // something else
                        DSWManager.traceStep(event.request, 'Fastest strategy failed fetching', {
                            status: response.status,
                            statusText: response.statusText
                        });
                        networkFailed = true;
                        treatCatch(response);
                    }
                }
            }

            function treatCache (result) {
                // if it was in cache, and network hasn't resolved previously
                if (result && !networkTreated) {
                    cacheTreated = true; // this will prevent network from resolving too
                    DSWManager.traceStep(event.request, 'Fastest strategy resolved from cached');
                    resolve(result);
                    return result;
                } else {
                    // lets flag cache as failed, once it's not there
                    cacheFailed = true;
                    if (!networkTreated) {
                        treatCatch();
                    }
                }
            }

            function treatCatch (response) {
                // if both network and cache failed,
                // we have a problem with the request, let's treat it
                if (networkFailed && cacheFailed) {
                    DSWManager.traceStep(event.request, 'Fastest strategy could not fetch nor find in cache');
                    resolve(DSWManager.treatBadPage(response, pathName, event));
                }
                // otherwise, we still got a chance on having a result from
                // one of the sources (network or cache), and keep waiting for it
            }

            // one promise go for the network
            // if browser is offline, there is no need to try the request
            goFetch(rule,
                request.clone(),
                event,
                matching)
            .then(treatFetch)
            .catch(treatFetch);

            // the other, for the cache
            cacheManager.get(rule,
                             request,
                             event,
                             matching,
                             false,
                             false) // will get, but not treat any failure
                .then(treatCache)
                .catch(treatCatch);
        });
    }
};

export default strategies;
