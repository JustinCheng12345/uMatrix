/*******************************************************************************

    µMatrix - a Chromium browser extension to black/white list requests.
    Copyright (C) 2014-2016  Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uMatrix
*/

/* global chrome, µMatrix */

/******************************************************************************/
/******************************************************************************/

(function() {

'use strict';

/******************************************************************************/

var µm = µMatrix;

// https://github.com/gorhill/httpswitchboard/issues/303
// Some kind of trick going on here:
//   Any scheme other than 'http' and 'https' is remapped into a fake
//   URL which trick the rest of µMatrix into being able to process an
//   otherwise unmanageable scheme. µMatrix needs web page to have a proper
//   hostname to work properly, so just like the 'behind-the-scene'
//   fake domain name, we map unknown schemes into a fake '{scheme}-scheme'
//   hostname. This way, for a specific scheme you can create scope with
//   rules which will apply only to that scheme.

/******************************************************************************/
/******************************************************************************/

µm.normalizePageURL = function(tabId, pageURL) {
    if ( vAPI.isBehindTheSceneTabId(tabId) ) {
        return 'http://' + this.behindTheSceneScope + '/';
    }

    // If the URL is that of our "blocked page" document, return the URL of
    // the blocked page.
    if ( pageURL.lastIndexOf(vAPI.getURL('main-blocked.html'), 0) === 0 ) {
        var matches = /main-blocked\.html\?details=([^&]+)/.exec(pageURL);
        if ( matches && matches.length === 2 ) {
            try {
                var details = JSON.parse(atob(matches[1]));
                pageURL = details.url;
            } catch (e) {
            }
        }
    }

    var uri = this.URI.set(pageURL);
    var scheme = uri.scheme;
    if ( scheme === 'https' || scheme === 'http' ) {
        return uri.normalizedURI();
    }

    var fakeHostname = scheme + '-scheme';

    if ( uri.hostname !== '' ) {
        fakeHostname = uri.hostname + '.' + fakeHostname;
    } else if ( scheme === 'about' ) {
        fakeHostname = uri.path + '.' + fakeHostname;
    }

    return 'http://' + fakeHostname + '/';
};

/******************************************************************************/
/******************************************************************************

To keep track from which context *exactly* network requests are made. This is
often tricky for various reasons, and the challenge is not specific to one
browser.

The time at which a URL is assigned to a tab and the time when a network
request for a root document is made must be assumed to be unrelated: it's all
asynchronous. There is no guaranteed order in which the two events are fired.

Also, other "anomalies" can occur:

- a network request for a root document is fired without the corresponding
tab being really assigned a new URL
<https://github.com/chrisaljoudi/uBlock/issues/516>

- a network request for a secondary resource is labeled with a tab id for
which no root document was pulled for that tab.
<https://github.com/chrisaljoudi/uBlock/issues/1001>

- a network request for a secondary resource is made without the root
document to which it belongs being formally bound yet to the proper tab id,
causing a bad scope to be used for filtering purpose.
<https://github.com/chrisaljoudi/uBlock/issues/1205>
<https://github.com/chrisaljoudi/uBlock/issues/1140>

So the solution here is to keep a lightweight data structure which only
purpose is to keep track as accurately as possible of which root document
belongs to which tab. That's the only purpose, and because of this, there are
no restrictions for when the URL of a root document can be associated to a tab.

Before, the PageStore object was trying to deal with this, but it had to
enforce some restrictions so as to not descend into one of the above issues, or
other issues. The PageStore object can only be associated with a tab for which
a definitive navigation event occurred, because it collects information about
what occurred in the tab (for example, the number of requests blocked for a
page).

The TabContext objects do not suffer this restriction, and as a result they
offer the most reliable picture of which root document URL is really associated
to which tab. Moreover, the TabObject can undo an association from a root
document, and automatically re-associate with the next most recent. This takes
care of <https://github.com/chrisaljoudi/uBlock/issues/516>.

The PageStore object no longer cache the various information about which
root document it is currently bound. When it needs to find out, it will always
defer to the TabContext object, which will provide the real answer. This takes
case of <https://github.com/chrisaljoudi/uBlock/issues/1205>. In effect, the
master switch and dynamic filtering rules can be evaluated now properly even
in the absence of a PageStore object, this was not the case before.

Also, the TabContext object will try its best to find a good candidate root
document URL for when none exists. This takes care of 
<https://github.com/chrisaljoudi/uBlock/issues/1001>.

The TabContext manager is self-contained, and it takes care to properly
housekeep itself.

*/

µm.tabContextManager = (function() {
    var tabContexts = Object.create(null);

    // https://github.com/chrisaljoudi/uBlock/issues/1001
    // This is to be used as last-resort fallback in case a tab is found to not
    // be bound while network requests are fired for the tab.
    var mostRecentRootDocURL = '';
    var mostRecentRootDocURLTimestamp = 0;

    var gcPeriod = 31 * 60 * 1000; // every 31 minutes

    // A pushed entry is removed from the stack unless it is committed with
    // a set time.
    var StackEntry = function(url, commit) {
        this.url = url;
        this.committed = commit;
        this.tstamp = Date.now();
    };

    var TabContext = function(tabId) {
        this.tabId = tabId;
        this.stack = [];
        this.rawURL =
        this.normalURL =
        this.scheme =
        this.rootHostname =
        this.rootDomain = '';
        this.secure = false;
        this.commitTimer = null;
        this.gcTimer = null;

        tabContexts[tabId] = this;
    };

    TabContext.prototype.destroy = function() {
        if ( vAPI.isBehindTheSceneTabId(this.tabId) ) {
            return;
        }
        if ( this.gcTimer !== null ) {
            clearTimeout(this.gcTimer);
            this.gcTimer = null;
        }
        delete tabContexts[this.tabId];
    };

    TabContext.prototype.onTab = function(tab) {
        if ( tab ) {
            this.gcTimer = vAPI.setTimeout(this.onGC.bind(this), gcPeriod);
        } else {
            this.destroy();
        }
    };

    TabContext.prototype.onGC = function() {
        this.gcTimer = null;
        if ( vAPI.isBehindTheSceneTabId(this.tabId) ) {
            return;
        }
        vAPI.tabs.get(this.tabId, this.onTab.bind(this));
    };

    // https://github.com/gorhill/uBlock/issues/248
    // Stack entries have to be committed to stick. Non-committed stack
    // entries are removed after a set delay.
    TabContext.prototype.onCommit = function() {
        if ( vAPI.isBehindTheSceneTabId(this.tabId) ) {
            return;
        }
        this.commitTimer = null;
        // Remove uncommitted entries at the top of the stack.
        var i = this.stack.length;
        while ( i-- ) {
            if ( this.stack[i].committed ) {
                break;
            }
        }
        // https://github.com/gorhill/uBlock/issues/300
        // If no committed entry was found, fall back on the bottom-most one
        // as being the committed one by default.
        if ( i === -1 && this.stack.length !== 0 ) {
            this.stack[0].committed = true;
            i = 0;
        }
        i += 1;
        if ( i < this.stack.length ) {
            this.stack.length = i;
            this.update();
            µm.bindTabToPageStats(this.tabId, 'newURL');
        }
    };

    // This takes care of orphanized tab contexts. Can't be started for all
    // contexts, as the behind-the-scene context is permanent -- so we do not
    // want to flush it.
    TabContext.prototype.autodestroy = function() {
        if ( vAPI.isBehindTheSceneTabId(this.tabId) ) {
            return;
        }
        this.gcTimer = vAPI.setTimeout(this.onGC.bind(this), gcPeriod);
    };

    // Update just force all properties to be updated to match the most recent
    // root URL.
    TabContext.prototype.update = function() {
        if ( this.stack.length === 0 ) {
            this.rawURL = this.normalURL = this.scheme =
            this.rootHostname = this.rootDomain = '';
            this.secure = false;
            return;
        }
        this.rawURL = this.stack[this.stack.length - 1].url;
        this.normalURL = µm.normalizePageURL(this.tabId, this.rawURL);
        this.scheme = µm.URI.schemeFromURI(this.rawURL);
        this.rootHostname = µm.URI.hostnameFromURI(this.normalURL);
        this.rootDomain = µm.URI.domainFromHostname(this.rootHostname) || this.rootHostname;
        this.secure = µm.URI.isSecureScheme(this.scheme);
    };

    // Called whenever a candidate root URL is spotted for the tab.
    TabContext.prototype.push = function(url, context) {
        if ( vAPI.isBehindTheSceneTabId(this.tabId) ) {
            return;
        }
        var committed = context !== undefined;
        var count = this.stack.length;
        var topEntry = this.stack[count - 1];
        if ( topEntry && topEntry.url === url ) {
            if ( committed ) {
                topEntry.committed = true;
            }
            return;
        }
        if ( this.commitTimer !== null ) {
            clearTimeout(this.commitTimer);
        }
        if ( committed ) {
            this.stack = [new StackEntry(url, true)];
        } else {
            this.stack.push(new StackEntry(url));
            this.commitTimer = vAPI.setTimeout(this.onCommit.bind(this), 1000);
        }
        this.update();
        µm.bindTabToPageStats(this.tabId, context);
    };

    // These are to be used for the API of the tab context manager.

    var push = function(tabId, url, context) {
        var entry = tabContexts[tabId];
        if ( entry === undefined ) {
            entry = new TabContext(tabId);
            entry.autodestroy();
        }
        entry.push(url, context);
        mostRecentRootDocURL = url;
        mostRecentRootDocURLTimestamp = Date.now();
        return entry;
    };

    // Find a tab context for a specific tab. If none is found, attempt to
    // fix this. When all fail, the behind-the-scene context is returned.
    var mustLookup = function(tabId, url) {
        var entry;
        if ( url !== undefined ) {
            entry = push(tabId, url);
        } else {
            entry = tabContexts[tabId];
        }
        if ( entry !== undefined ) {
            return entry;
        }
        // https://github.com/chrisaljoudi/uBlock/issues/1025
        // Google Hangout popup opens without a root frame. So for now we will
        // just discard that best-guess root frame if it is too far in the
        // future, at which point it ceases to be a "best guess".
        if ( mostRecentRootDocURL !== '' && mostRecentRootDocURLTimestamp + 500 < Date.now() ) {
            mostRecentRootDocURL = '';
        }
        // https://github.com/chrisaljoudi/uBlock/issues/1001
        // Not a behind-the-scene request, yet no page store found for the
        // tab id: we will thus bind the last-seen root document to the
        // unbound tab. It's a guess, but better than ending up filtering
        // nothing at all.
        if ( mostRecentRootDocURL !== '' ) {
            return push(tabId, mostRecentRootDocURL);
        }
        // If all else fail at finding a page store, re-categorize the
        // request as behind-the-scene. At least this ensures that ultimately
        // the user can still inspect/filter those net requests which were
        // about to fall through the cracks.
        // Example: Chromium + case #12 at
        //          http://raymondhill.net/ublock/popup.html
        return tabContexts[vAPI.noTabId];
    };

    var lookup = function(tabId) {
        return tabContexts[tabId] || null;
    };

    // Behind-the-scene tab context
    (function() {
        var entry = new TabContext(vAPI.noTabId);
        entry.stack.push(new StackEntry('', true));
        entry.rawURL = '';
        entry.normalURL = µm.normalizePageURL(entry.tabId);
        entry.rootHostname = µm.URI.hostnameFromURI(entry.normalURL);
        entry.rootDomain = µm.URI.domainFromHostname(entry.rootHostname) || entry.rootHostname;
    })();

    vAPI.tabs.onNavigation = function(details) {
        var tabId = details.tabId;
        if ( vAPI.isBehindTheSceneTabId(tabId) ) {
            return;
        }
        push(tabId, details.url, 'newURL');
    };

    vAPI.tabs.onUpdated = function(tabId, changeInfo, tab) {
        if ( typeof tab.url !== 'string' || tab.url === '' ) {
            return;
        }
        if ( vAPI.isBehindTheSceneTabId(tabId) ) {
            return;
        }
        if ( changeInfo.url ) {
            push(tabId, changeInfo.url, 'updateURL');
        }
    };

    vAPI.tabs.onClosed = function(tabId) {
        µm.unbindTabFromPageStats(tabId);
        var entry = tabContexts[tabId];
        if ( entry instanceof TabContext ) {
            entry.destroy();
        }
    };

    return {
        push: push,
        lookup: lookup,
        mustLookup: mustLookup
    };
})();

vAPI.tabs.registerListeners();

/******************************************************************************/
/******************************************************************************/

// Create an entry for the tab if it doesn't exist

µm.bindTabToPageStats = function(tabId, context) {
    this.updateBadgeAsync(tabId);

    // Do not create a page store for URLs which are of no interests
    // Example: dev console
    var tabContext = this.tabContextManager.lookup(tabId);
    if ( tabContext === null ) {
        throw new Error('Unmanaged tab id: ' + tabId);
    }

    // rhill 2013-11-24: Never ever rebind behind-the-scene
    // virtual tab.
    // https://github.com/gorhill/httpswitchboard/issues/67
    if ( vAPI.isBehindTheSceneTabId(tabId) ) {
        return this.pageStores[tabId];
    }

    var normalURL = tabContext.normalURL;
    var pageStore = this.pageStores[tabId] || null;

    // The previous page URL, if any, associated with the tab
    if ( pageStore !== null ) {
        // No change, do not rebind
        if ( pageStore.pageUrl === normalURL ) {
            return pageStore;
        }

        // https://github.com/gorhill/uMatrix/issues/37
        // Just rebind whenever possible: the URL changed, but the document
        // maybe is the same.
        // Example: Google Maps, Github
        // https://github.com/gorhill/uMatrix/issues/72
        // Need to double-check that the new scope is same as old scope
        if ( context === 'updateURL' && pageStore.pageHostname === tabContext.rootHostname ) {
            pageStore.rawURL = tabContext.rawURL;
            pageStore.normalURL = normalURL;
            this.updateTitle(tabId);
            this.pageStoresToken = Date.now();
            return pageStore;
        }

        // We won't be reusing this page store.
        this.unbindTabFromPageStats(tabId);
    }

    // Try to resurrect first.
    pageStore = this.resurrectPageStore(tabId, normalURL);
    if ( pageStore === null ) {
        pageStore = this.PageStore.factory(tabContext);
    }
    this.pageStores[tabId] = pageStore;
    this.updateTitle(tabId);
    this.pageStoresToken = Date.now();

    // console.debug('tab.js > bindTabToPageStats(): dispatching traffic in tab id %d to page store "%s"', tabId, pageUrl);

    return pageStore;
};

/******************************************************************************/

µm.unbindTabFromPageStats = function(tabId) {
    // Never unbind behind-the-scene page store.
    if ( vAPI.isBehindTheSceneTabId(tabId) ) {
        return;
    }

    var pageStore = this.pageStores[tabId] || null;
    if ( pageStore === null ) {
        return;
    }

    delete this.pageStores[tabId];
    this.pageStoresToken = Date.now();

    if ( pageStore.incinerationTimer ) {
        clearTimeout(pageStore.incinerationTimer);
        pageStore.incinerationTimer = null;
    }

    if ( this.pageStoreCemetery.hasOwnProperty(tabId) === false ) {
        this.pageStoreCemetery[tabId] = {};
    }
    var pageStoreCrypt = this.pageStoreCemetery[tabId];

    var pageURL = pageStore.pageUrl;
    pageStoreCrypt[pageURL] = pageStore;

    pageStore.incinerationTimer = vAPI.setTimeout(
        this.incineratePageStore.bind(this, tabId, pageURL),
        4 * 60 * 1000
    );
};

/******************************************************************************/

µm.resurrectPageStore = function(tabId, pageURL) {
    if ( this.pageStoreCemetery.hasOwnProperty(tabId) === false ) {
        return null;
    }
    var pageStoreCrypt = this.pageStoreCemetery[tabId];

    if ( pageStoreCrypt.hasOwnProperty(pageURL) === false ) {
        return null;
    }

    var pageStore = pageStoreCrypt[pageURL];

    if ( pageStore.incinerationTimer !== null ) {
        clearTimeout(pageStore.incinerationTimer);
        pageStore.incinerationTimer = null;
    }

    delete pageStoreCrypt[pageURL];
    if ( Object.keys(pageStoreCrypt).length === 0 ) {
        delete this.pageStoreCemetery[tabId];
    }

    return pageStore;
};

/******************************************************************************/

µm.incineratePageStore = function(tabId, pageURL) {
    if ( this.pageStoreCemetery.hasOwnProperty(tabId) === false ) {
        return;
    }
    var pageStoreCrypt = this.pageStoreCemetery[tabId];

    if ( pageStoreCrypt.hasOwnProperty(pageURL) === false ) {
        return;
    }

    var pageStore = pageStoreCrypt[pageURL];
    if ( pageStore.incinerationTimer !== null ) {
        clearTimeout(pageStore.incinerationTimer);
        pageStore.incinerationTimer = null;
    }

    delete pageStoreCrypt[pageURL];
    if ( Object.keys(pageStoreCrypt).length === 0 ) {
        delete this.pageStoreCemetery[tabId];
    }

    pageStore.dispose();
};

/******************************************************************************/

µm.pageStoreFromTabId = function(tabId) {
    return this.pageStores[tabId] || null;
};

// Never return null
µm.mustPageStoreFromTabId = function(tabId) {
    return this.pageStores[tabId] || this.pageStores[vAPI.noTabId];
};

/******************************************************************************/

// Log a request

µm.recordFromTabId = function(tabId, type, url, blocked) {
    var pageStore = this.pageStoreFromTabId(tabId);
    if ( pageStore === null ) {
        return;
    }
    pageStore.recordRequest(type, url, blocked);
    this.logger.writeOne(tabId, 'net', pageStore.pageHostname, url, type, blocked);
};

/******************************************************************************/

µm.forceReload = function(tabId) {
    vAPI.tabs.reload(tabId, { bypassCache: true });
};

/******************************************************************************/

// Update badge

// rhill 2013-11-09: well this sucks, I can't update icon/badge
// incrementally, as chromium overwrite the icon at some point without
// notifying me, and this causes internal cached state to be out of sync.

µm.updateBadgeAsync = (function() {
    var tabIdToTimer = Object.create(null);

    var updateBadge = function(tabId) {
        delete tabIdToTimer[tabId];

        var iconId = null;
        var badgeStr = '';

        var pageStore = this.pageStoreFromTabId(tabId);
        if ( pageStore !== null ) {
            var total = pageStore.perLoadAllowedRequestCount +
                        pageStore.perLoadBlockedRequestCount;
            if ( total ) {
                var squareSize = 19;
                var greenSize = squareSize * Math.sqrt(pageStore.perLoadAllowedRequestCount / total);
                iconId = greenSize < squareSize/2 ? Math.ceil(greenSize) : Math.floor(greenSize);
            }
            if ( this.userSettings.iconBadgeEnabled && pageStore.distinctRequestCount !== 0) {
                badgeStr = this.formatCount(pageStore.distinctRequestCount);
            }
        }

        vAPI.setIcon(tabId, iconId, badgeStr);
    };

    return function(tabId) {
        if ( tabIdToTimer[tabId] ) {
            return;
        }
        if ( vAPI.isBehindTheSceneTabId(tabId) ) {
            return;
        }
        tabIdToTimer[tabId] = vAPI.setTimeout(updateBadge.bind(this, tabId), 500);
    };
})();

/******************************************************************************/

µm.updateTitle = (function() {
    var tabIdToTimer = Object.create(null);
    var tabIdToTryCount = Object.create(null);
    var delay = 499;

    var tryNoMore = function(tabId) {
        delete tabIdToTryCount[tabId];
    };

    var tryAgain = function(tabId) {
        var count = tabIdToTryCount[tabId];
        if ( count === undefined ) {
            return false;
        }
        if ( count === 1 ) {
            delete tabIdToTryCount[tabId];
            return false;
        }
        tabIdToTryCount[tabId] = count - 1;
        tabIdToTimer[tabId] = vAPI.setTimeout(updateTitle.bind(µm, tabId), delay);
        return true;
    };

    var onTabReady = function(tabId, tab) {
        if ( !tab ) {
            return tryNoMore(tabId);
        }
        var pageStore = this.pageStoreFromTabId(tabId);
        if ( pageStore === null ) {
            return tryNoMore(tabId);
        }
        if ( !tab.title && tryAgain(tabId) ) {
            return;
        }
        // https://github.com/gorhill/uMatrix/issues/225
        // Sometimes title changes while page is loading.
        var settled = tab.title && tab.title === pageStore.title;
        pageStore.title = tab.title || tab.url || '';
        this.pageStoresToken = Date.now();
        if ( settled || !tryAgain(tabId) ) {
            tryNoMore(tabId);
        }
    };

    var updateTitle = function(tabId) {
        delete tabIdToTimer[tabId];
        vAPI.tabs.get(tabId, onTabReady.bind(this, tabId));
    };

    return function(tabId) {
        if ( vAPI.isBehindTheSceneTabId(tabId) ) {
            return;
        }
        if ( tabIdToTimer[tabId] ) {
            clearTimeout(tabIdToTimer[tabId]);
        }
        tabIdToTimer[tabId] = vAPI.setTimeout(updateTitle.bind(this, tabId), delay);
        tabIdToTryCount[tabId] = 5;
    };
})();

/******************************************************************************/

// Stale page store entries janitor
// https://github.com/chrisaljoudi/uBlock/issues/455

(function() {
    var cleanupPeriod = 7 * 60 * 1000;
    var cleanupSampleAt = 0;
    var cleanupSampleSize = 11;

    var cleanup = function() {
        var vapiTabs = vAPI.tabs;
        var tabIds = Object.keys(µm.pageStores).sort();
        var checkTab = function(tabId) {
            vapiTabs.get(tabId, function(tab) {
                if ( !tab ) {
                    µm.unbindTabFromPageStats(tabId);
                }
            });
        };
        if ( cleanupSampleAt >= tabIds.length ) {
            cleanupSampleAt = 0;
        }
        var tabId;
        var n = Math.min(cleanupSampleAt + cleanupSampleSize, tabIds.length);
        for ( var i = cleanupSampleAt; i < n; i++ ) {
            tabId = tabIds[i];
            if ( vAPI.isBehindTheSceneTabId(tabId) ) {
                continue;
            }
            checkTab(tabId);
        }
        cleanupSampleAt = n;

        vAPI.setTimeout(cleanup, cleanupPeriod);
    };

    vAPI.setTimeout(cleanup, cleanupPeriod);
})();

/******************************************************************************/

})();
