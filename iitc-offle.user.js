// ==UserScript==
// @id             iitc-plugin-offle
// @name           IITC plugin: offle
// @category       Misc
// @version        0.10
// @namespace      https://github.com/vrabcak/iitc-offle
// @description    Offle
// @match          https://intel.ingress.com/*
// @grant          none
// ==/UserScript==

function wrapper(plugin_info) {
    // ensure plugin framework is there, even if iitc is not yet loaded
    if (typeof window.plugin !== 'function') {
        window.plugin = function () {};
    }

    // PLUGIN START ////////////////////////////////////////////////////////

    // use own namespace for plugin
    const offle = window.plugin.offle = function () {};
    offle.portalDb = {};
    offle.lastAddedDb = {};

    const defaultSettings = {
        symbol: '&bull;',
        symbolWithMission: '◉',
        symbolWithMissionEnabled: false,
        maxVisibleCount: 2000,
        showFlags: 1 + 2,
        showFlagsInvert: true
    };

    offle.settings = defaultSettings;
    try {
        let s = JSON.parse(localStorage.getItem("offle.settings"));
        if (s != null && typeof s === 'object') {
            offle.settings = Object.assign({}, defaultSettings, s);
        }
    } catch (e) {
    }

    const saveSettings = function() {
        localStorage.setItem("offle.settings", JSON.stringify(offle.settings));
    }

    const isVisited = function(flags) {
        return (flags & 1) == 1;
    }

    const isCaptured = function(flags) {
        return (flags & 2) == 2;
    }

    const isScouted = function(flags) {
        return (flags & 4) == 4;
    }

    const getFlags = function(data) {
        let flags = null;
		if (data.portal.options.ent.length === 3 && data.portal.options.ent[2].length >= 19 && data.portal.options.ent[2][18] > 0) {
            flags = data.portal.options.ent[2][18];
            console.debug("portal flags: %s %s", data.portal.options.guid, flags);
		}
        return flags;
    }

    // Use portal add event to save it to db
    offle.portalAdded = function (data) {

        offle.addPortal(
            data.portal.options.guid,
            data.portal.options.data.title,
            data.portal.getLatLng(),
            data.portal.options.data.mission,
            getFlags(data)
        );
    };

    // Always update portal data if displayed in sidebar (to handle e.g. moved portals)
    offle.portalDetailsUpdated = function (data) {

        var guid = data.portal.options.guid,
            name = data.portal.options.data.title;

        if (name) { //update data only with portals with full details

            let portal = offle.portalDb[guid];
            if (portal == null) offle.portalDb[guid] = portal = {}; // create if not exists already
            let ll = data.portal.getLatLng();
            portal.lat = ll.lat;
            portal.lng = ll.lng;
            portal.name = data.portal.options.data.title;
            portal.mission = data.portal.options.data.mission;
            let flags = getFlags(data);
            if (flags != null) portal.flags = flags;
            offle.renderVisiblePortals();
            localforage.setItem('portalDb', offle.portalDb);
        }
    };

    offle.addPortal = function (guid, name, latLng, mission, flags) {

        var notInDb = guid && !(guid in offle.portalDb);        
        var old = offle.portalDb[guid];        

        //console.log("AddPortal: %o %o %o %o %o", guid, name, latLng, mission, old, notInDb);

        var newName = name && old && old.name != name;
        var newPos = latLng && old && (old.lat != latLng.lat || old.lng != latLng.lng);
        var newMission = mission != null && old && old.mission != mission;
        var newFlags = flags != null && (!old || old.flags != flags);
        var newData = newName || newPos || newMission || newFlags;

        //console.log("AddPortal ", guid," ",name, "::", notInDb, " ", newName, " ", newPos, " ", newMission);

        var now = Date.now();

        if (notInDb || newData) {

            var hadName = old && old.name != null && old.name != old.guid;

            //add to last added list only new portals or update already displayed guid with new data
            if (notInDb || (((newName && hadName) || newPos) /*&& (guid in offle.lastAddedDb)*/)) {
                var la = {
                    name: notInDb || newName ? name || guid : old.name,
                    latLng: notInDb || newPos ? latLng : { lat: old.lat, lng: old.lng },
                    unique: false,
                    isNew: notInDb
                };
                if (newName) la.oldName = old.name;
                if (newPos) la.oldPos = { lat: old.lat, lng: old.lng };

                if (!(window.plugin.uniques && (guid in window.plugin.uniques.uniques))) {
                    la.unique = true;
                }

                offle.lastAddedDb[guid] = la;
            }
            
            let portal = offle.portalDb[guid] || {};
            if (notInDb || newName) portal.name = name || guid;
            if (notInDb || newPos) { portal.lat = latLng.lat; portal.lng = latLng.lng; }
            if (notInDb || mission) portal.mission = mission;
            if (notInDb || !portal.createTs)  portal.createTs = now;
            if (notInDb || newFlags) portal.flags = flags;
            portal.modifyTs = now;
            if (notInDb) offle.portalDb[guid] = portal;
            offle.dirtyDb = true; //mark Db dirty to by stored on mapDataRefreshEnd
            offle.renderPortal(guid);
            offle.updatePortalCounter();
            offle.updateLACounter();
            offle.updateLAList();            
        }

        // set last seen timestamp so we can track potentially removed portals later
        offle.portalDb[guid].seenTs = now;
        if (!offle.portalDb[guid].createTs)
            offle.portalDb[guid].createTs = offle.portalDb[guid].modifyTs = now;
        offle.dirtyDb = true; // yes(!) - we need to save every scan
    };

    offle.currentPortalMarkers = {};

    offle.renderPortal = function (guid) {

        let portal = offle.portalDb[guid];

        var oldMarker = offle.currentPortalMarkers[guid];
        if (oldMarker) // avoid moved portals staying in both locations on the map until refresh
            try { oldMarker.remove(); } catch (e) {};

        var portalMarker, uniqueInfo,
            iconCSSClass = 'offle-marker';

        if (window.plugin.uniques) {
            uniqueInfo = window.plugin.uniques.uniques[guid];
        }

        let scouted, visited, captured;
        scouted = visited = captured = false;
        
        let showScouted = isScouted(offle.settings.showFlags);
        let showVisited = isVisited(offle.settings.showFlags);
        let showCaptured = isCaptured(offle.settings.showFlags);

        if (portal.flags) {
            scouted = isScouted(portal.flags);
            visited = isVisited(portal.flags);
            captured = isCaptured(portal.flags);
        } else {
            if (uniqueInfo) {
                visited = uniqueInfo.visited;
                captured = uniqueInfo.captured;
            }
        }

        if (scouted) iconCSSClass += ' offle-marker-scouted';
        if (visited) iconCSSClass += ' offle-marker-visited';
        if (captured) iconCSSClass += ' offle-marker-captured';

        let html = "";

        if (offle.settings.showFlagsInvert) {
            html +=
                (scouted || !showScouted ? '' : '<div class="offle-marker-unscouted-overlay"></div>') +
                (captured || !showCaptured ? '' : '<div class="offle-marker-uncaptured-overlay"></div>') +
                ((visited || captured) || !showVisited ? '' : '<div class="offle-marker-unvisited-overlay"></div>') ;
        } else {
            html +=
                (scouted && showScouted ? '<div class="offle-marker-scouted-overlay"></div>' : '') +
                ((visited || captured) && showVisited ? '<div class="offle-marker-visited-overlay"></div>' : '') +
                (captured && showCaptured ? '<div class="offle-marker-captured-overlay"></div>' : '');
        }

        html +=
            `<div class="${iconCSSClass}">` + (offle.portalDb[guid].mission && offle.settings.symbolWithMissionEnabled ? offle.settings.symbolWithMission : offle.settings.symbol) + '</div>';

        portalMarker = L.marker(portal /* {lat, lng} */, {
            icon: L.divIcon({
                //className: iconCSSClass,
                className: 'offle-marker-outer',
                iconAnchor: [15, 15],
                iconSize: [30, 30],
                html: html
            }),
            name: offle.portalDb[guid].name,
            title: offle.portalDb[guid].name || ''
        });

        portalMarker.on('click', function () {
            window.renderPortalDetails(guid);
        });

        portalMarker.addTo(offle.portalLayerGroup);
        offle.currentPortalMarkers[guid] = portalMarker;

        if (window.plugin.keys) {
            var keyCount = window.plugin.keys.keys[guid];
            if (keyCount > 0) {
                var keyMarker = L.marker(offle.portalDb[guid], {
                    icon: L.divIcon({
                        className: 'offle-key',
                        iconAnchor: [6, 7],
                        iconSize: [12, 10],
                        html: keyCount
                    }),
                    guid: guid
                });
                keyMarker.addTo(offle.keyLayerGroup);
            }
        }

    };

    offle.clearLayer = function () {
        offle.portalLayerGroup.clearLayers();
        offle.keyLayerGroup.clearLayers();
        offle.currentPortalMarkers = {};
    };

    offle.saveData = function (force) {
        if (offle.dirtyDb || force === true) {
            //console.log("Storing new portals to localStorage");
            localforage.setItem('portalDb', offle.portalDb);
        }
        offle.dirtyDb = false;
    };

    offle.mapDataRefreshStart = function () {
        //console.log("offle: starting map refresh..");
    };

    offle.mapDataRefreshEnd = function () {
        //console.log("offle: map refresh ended!");
        offle.saveData();
    };

    offle.setupLayer = function () {
        offle.portalLayerGroup = new L.LayerGroup();
        window.addLayerGroup('offlePortals', offle.portalLayerGroup, false);
        offle.keyLayerGroup = new L.LayerGroup();
        window.addLayerGroup('offleKeys', offle.keyLayerGroup, false);
    };

    let markerSize = 30;
    let colors = {
        neutral: "#FF6200",
        captured: "#00BB00",
        visited: "#FFCE00",
        scouted: "#FFCE00",
        // generic
        true: "#00BB00", // green
        false: "#FF2000" // red
    };

    let rectangleWidth = 2;
    let circleWidth = 4;

    offle.setupCSS = function () {
        $('<style>')
            .prop('type', 'text/css')
            .html(`

            #offle-info {
                box-sizing: border-box;
            }

            #offle-info table {
                width: 100%;
                border-collapse: collapse;
            }

            #offle-info tr td:first-child {
                width: 70%;
            }

            #offle-info td {
                padding: 0.35em 0;
                vertical-align: center;
            }

            .offle-marker-outer {
                /*background-color: rgba(0,0,0,0.75);*/
                width: ${markerSize}px;
                height: ${markerSize}px;
            }

            .offle-marker {
                width: ${markerSize}px;
                height: ${markerSize}px;
                position: absolute;
                font-size: ${markerSize}px;
                line-height: ${markerSize}px;
                text-align: center;
                color: ${colors.neutral};
                font-family: monospace;
                padding-bottom: 1px;
            }

            .offle-marker-visited {
                color: ${colors.visited};
            }

            .offle-marker-captured {
                color: ${colors.captured};
            }

            .offle-marker-scouted {
                color: ${colors.scouted};
            }

            .offle-marker-unvisited-overlay {
                position: absolute;
                width: ${markerSize}px;
                height: ${markerSize}px;
                font-size: ${markerSize}px;
                line-height: ${markerSize}px;
                text-align: center;
                border-radius: ${markerSize}px;
                border: ${circleWidth}px dashed ${colors.neutral};
                box-sizing: border-box;
            }
            
            .offle-marker-uncaptured-overlay {
                position: absolute;
                width: ${markerSize}px;
                height: ${markerSize}px;
                font-size: ${markerSize}px;
                line-height: ${markerSize}px;
                text-align: center;
                border-radius: ${markerSize}px;
                border: ${circleWidth}px solid ${colors.false};
                box-sizing: border-box;
            }

            .offle-marker-unscouted-overlay {
                opacity: 0.85;
                position: absolute;
                width: ${markerSize}px;
                height: ${markerSize}px;
                font-size: ${markerSize}px;
                line-height: ${markerSize}px;
                text-align: center;
                border: ${rectangleWidth}px solid ${colors.false};
                box-sizing: border-box;
            }

            .offle-marker-visited-overlay {
                position: absolute;
                width: ${markerSize}px;
                height: ${markerSize}px;
                font-size: ${markerSize}px;
                line-height: ${markerSize}px;
                text-align: center;
                border-radius: ${markerSize}px;
                border: ${circleWidth}px dotted ${colors.neutral};
                box-sizing: border-box;
            }

            .offle-marker-captured-overlay {
                position: absolute;
                width: ${markerSize}px;
                height: ${markerSize}px;
                font-size: ${markerSize}px;
                line-height: ${markerSize}px;
                text-align: center;
                border-radius: ${markerSize}px;
                border: ${circleWidth}px solid ${colors.true};
                box-sizing: border-box;
            }

            .offle-marker-scouted-overlay {
                opacity: 0.85;
                position: absolute;
                width: ${markerSize}px;
                height: ${markerSize}px;
                font-size: ${markerSize}px;
                line-height: ${markerSize}px;
                text-align: center;
                border: ${rectangleWidth}px solid ${colors.true};
                box-sizing: border-box;
            }

            .offle-portal-counter {
                display: none;
                position: absolute;
                top: 0;
                left: 40vh;
                background-color: orange;
                z-index: 4002;
                cursor: pointer;
            }

            .offle-key {
                font-size: 10px;
                color: #FFFFBB;
                font-family: monospace;
                text-align: center;
                text-shadow: 0 0 0.5em black, 0 0 0.5em black, 0 0 0.5em black;
                pointer-events: none;
                -webkit-text-size-adjust: none;
            }
            `)
            .appendTo('head');
    };

    offle.updatePortalCounter = function () {
        $('#offle-portal-counter').html(Object.keys(offle.portalDb).length);
    };


    offle.getVisiblePortals = function () {
        var keys = Object.keys(offle.portalDb);
        var actualBounds = map.getBounds();
        var keysInView = keys.filter(function (key) {
            var ll,
                portal = offle.portalDb[key];
            if (portal.lat && portal.lng) {
                ll = L.latLng(portal.lat, portal.lng);
                return actualBounds.contains(ll);
            }
            return false;
        });
        $('#visible-portals-counter').html(keysInView.length);

        return keysInView;
    };

    offle.renderVisiblePortals = function () {
        var visiblePortalsKeys = offle.getVisiblePortals();
        if (visiblePortalsKeys.length < offle.settings.maxVisibleCount) {
            visiblePortalsKeys.forEach(function (key) {
                offle.renderPortal(key);
            });
        }
    };

    offle.onMapMove = function () {
        offle.renderVisiblePortals();
    };

    offle.clearDb = function () {

        if (confirm('Are you sure to permanently delete ALL the stored portals?')) {
            localforage.removeItem('portalDb');
            offle.portalDb = {};
            offle.clearLayer();
            offle.updatePortalCounter();
        }

    };

    offle.changeSymbol = function (event) {
        offle.settings.symbol = event.target.value;
        saveSettings();
        offle.clearLayer();
        offle.renderVisiblePortals();
    };

    offle.changeSymbolWithMission = function (event) {
        offle.settings.symbolWithMission = event.target.value;
        saveSettings();
        offle.clearLayer();
        offle.renderVisiblePortals();
    };

    offle.toggleShowFlags = function (event, flag) {
        offle.settings.showFlags = (offle.settings.showFlags & ~flag) | (event.target.checked ? flag : 0);
        saveSettings();
        offle.clearLayer();
        offle.renderVisiblePortals();
    }

    offle.toggleShowFlagsInvert = function (event) {
        offle.settings.showFlagsInvert = event.target.checked === true;
        saveSettings();
        offle.clearLayer();
        offle.renderVisiblePortals();
    }

    offle.toggleSymbolWithMission = function (event) {
        offle.settings.symbolWithMissionEnabled = event.target.checked;
        saveSettings();
        offle.clearLayer();
        offle.renderVisiblePortals();
    }

    offle.changeMaxVisibleCount = function (event) {
        offle.settings.maxVisibleCount = event.target.value;
        saveSettings();
        offle.clearLayer();
        offle.renderVisiblePortals();
    };

    offle.setupHtml = function () {

        $('#toolbox').append('<a id="offle-show-info" onclick="window.plugin.offle.showDialog();">Offle</a> ');

        offle.lastAddedDialogHtml = `
            <div id="offle-last-added-list">
                placeholder <br>
                placeholder
            </div>
            <button onclick="window.plugin.offle.clearLADb()">Clear</div>`

        $('body').append('<div class="offle-portal-counter" onclick="window.plugin.offle.showLAWindow();">0</div>');

    };

    offle.showDialog = function () {
        offle.dialogHtml = `<div id="offle-info">
            <div>
                <table>

                <tr><td>Offline portals count:</td><td><span id="offle-portal-counter">${ Object.keys(offle.portalDb).length }</span></td></tr>

                    <tr><td>Visible portals:</td><td><span id="visible-portals-counter">x</span></td></tr>

                    <tr><td>Unique portals visited:</td><td>${ window.plugin.uniques ? Object.keys(window.plugin.uniques.uniques).length : 'uniques plugin missing' }</td></tr>

                    <tr><td>Portal marker symbol:</td><td><input type="text" value="${offle.settings.symbol}" size="1" onchange="window.plugin.offle.changeSymbol(event)"></td></tr>

                    <tr>
                        <td><input type="checkbox" ${offle.settings.symbolWithMissionEnabled ? 'checked' : ''} onclick="window.plugin.offle.toggleSymbolWithMission(event)">Portal with mission marker symbol:</td>
                        <td><input type="text" value="${ offle.settings.symbolWithMission }" size="1" onchange="window.plugin.offle.changeSymbolWithMission(event)"></td>
                    </tr>

                    <tr>
                        <td>Show visited</td>
                        <td><input type="checkbox" ${offle.settings.showFlags & 1 ? 'checked' : ''} onclick="window.plugin.offle.toggleShowFlags(event, 1)"></td>
                    </tr>
                    <tr>
                        <td>Show captured</td>
                        <td><input type="checkbox" ${offle.settings.showFlags & 2 ? 'checked' : ''} onclick="window.plugin.offle.toggleShowFlags(event, 2)"></td>
                    </tr>
                    <tr>
                        <td>Show scout controlled</td>
                        <td><input type="checkbox" ${offle.settings.showFlags & 4 ? 'checked' : ''} onclick="window.plugin.offle.toggleShowFlags(event, 4)"></td>
                    </tr>
                    <tr>
                        <td>Invert (show missing)</td>
                        <td><input type="checkbox" ${offle.settings.showFlagsInvert ? 'checked' : ''} onclick="window.plugin.offle.toggleShowFlagsInvert(event)"></td>
                    </tr>

                    <tr><td>Max visible portals:</td><td><input type="number" value="${ offle.settings.maxVisibleCount }" size="5" onchange="window.plugin.offle.changeMaxVisibleCount(event)"></td></tr>
                </table>
                <div style="border-bottom: 60px;">
                    <div>
                        <button onclick="window.plugin.offle.showLAWindow();return false;">New portals</button>
                    </div>
                    <div>
                        <button onClick="window.plugin.offle.export();return false;">Export JSON</button>
                        <button onClick="window.plugin.offle.exportKML();return false;">Export KML</button>
                    </div>
                    <div>
                        <button onClick="window.plugin.offle.import();return false;">Import JSON</button>
                        <input type="file" id="fileInput" style="visibility: hidden">
                    </div>
                </div>
                <br>
                <a href="" id="dataDownloadLink" download="" style="display: none" onclick="this.style.display=\'none\'">click to download </a>
                <br><br>
                <button onclick="window.plugin.offle.clearDb();return false;" style="font-size: 5px;">Clear all offline portals</button>
            </div>`


        window.dialog({
            html: offle.dialogHtml,
            title: 'Offle',
            modal: false,
            id: 'offle-info'
        });
        offle.updatePortalCounter();
        offle.getVisiblePortals();
    };

    offle.zoomToPortalAndShow = function (guid) {
        var lat = offle.portalDb[guid].lat,
            lng = offle.portalDb[guid].lng,
            ll = [lat, lng];
        map.setView(ll, 15);
        window.renderPortalDetails(guid);
    };

    offle.showLAWindow = function () {

        window.dialog({
            html: offle.lastAddedDialogHtml,
            title: 'Portals added since last session:',
            modal: false,
            id: 'offle-LA',
            height: $(window).height() * 0.45
        });
        offle.updateLAList();

    };

    offle.updateLAList = function () { /// update list of last added portals
        var guids = Object.keys(offle.lastAddedDb);
        var portalListHtml = guids.map(function (guid) {
            var portal = offle.lastAddedDb[guid];
            var html = '<a onclick="window.plugin.offle.zoomToPortalAndShow(\'' + guid + '\');return false"' +
                (portal.unique ? 'style="color: #FF6200;"' : '')
                + 'href="/intel?pll=' + portal.latLng.lat + ',' + portal.latLng.lng + '">'
                + portal.name
                + '</a>';
            if (!portal.isNew) {
                if (portal.oldName) html += " (renamed: " + portal.oldName + ")";
                if (portal.oldPos) html += " (moved: " + (portal.latLng.lat - portal.oldPos.lat) + "," + (portal.latLng.lng - portal.oldPos.lng) + ")";
            }
            return html;
        }).join('<br />');
        $('#offle-last-added-list').html(portalListHtml);
    };

    offle.updateLACounter = function () {
        var count = Object.keys(offle.lastAddedDb).length;
        if (count > 0) {
            $('.offle-portal-counter').css('display', 'block').html('' + count);
        }

    };

    offle.clearLADb = function () {
        offle.lastAddedDb = {};
        offle.updateLAList();
        $('.offle-portal-counter').css('display', 'none');
    };

    offle.export = function () {
        var jsonDb = JSON.stringify(offle.portalDb);
        var blobDb = new Blob([jsonDb], {
            type: 'application/json'
        });
        var dataDownlodaLinkEl = document.getElementById('dataDownloadLink');
        dataDownlodaLinkEl.href = URL.createObjectURL(blobDb);
        dataDownlodaLinkEl.download = 'offle-export.json';
        dataDownlodaLinkEl.style.display = 'block';
    };

    offle.import = function () {
        var fileInputEl = document.getElementById('fileInput');

        function is_guid(guid) {
            var re = /(?:[a-f]|\d){32}\.\d{2}/;
            return guid.match(re) !== null;
        }

        function parseJSONAndImport(string_db) {
            var portal_db;
            if (string_db !== null) {
                try {
                    portal_db = JSON.parse(string_db);
                } catch (err) {
                    window.alert('Not valid portal database: \n' + err);
                    return;
                }
                var guids = Object.keys(portal_db);
                var len = guids.length;
                var old_len = Object.keys(offle.portalDb).length;
                for (var i = 0; i != len; ++i) {
                    var guid = guids[i];
                    if (!is_guid(guid)) {
                        continue;
                    }
                    var obj = portal_db[guid];
                    if (!obj.hasOwnProperty('lat') || !obj.hasOwnProperty('lng')) {
                        continue;
                    }
                    offle.portalDb[guid] = obj;
                }
                var new_len = Object.keys(offle.portalDb).length;
                offle.saveData(true);
                window.alert('Portals processed: ' + len + ', portals added:' + (new_len - old_len) + '.');

                offle.clearLayer(); // in case something was moved (avoid duplicates)
                offle.renderVisiblePortals();
            }
        }

        function handleFile() {
            var reader = new FileReader();
            if (this.files.length === 0) {
                return;
            }
            console.log(this.files[0].name, this.files[0].type);
            reader.onload = function (e) {
                parseJSONAndImport(e.target.result);
            };
            reader.readAsText(this.files[0]);
            fileInputEl.removeEventListener('change', handleFile, false);
        }

        fileInputEl.click();
        fileInputEl.addEventListener('change', handleFile, false);

    };

    offle.exportKML = function () {
        var kmlBlob;
        var dataDownlodaLinkEl = document.getElementById('dataDownloadLink');
        var kml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
            '<Document>\n';

        Object.keys(offle.portalDb).forEach(
            function (guid) {
                var name, escapedName;
                var obj = offle.portalDb[guid];
                if (!obj.hasOwnProperty('lat') || !obj.hasOwnProperty('lng')) {
                    return;
                }
                if (obj.hasOwnProperty('name') && obj.name) {
                    name = obj.name;
                } else {
                    name = guid;
                }

                escapedName = name.replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&apos;');

                kml += '<Placemark>\n';
                kml += '<name>' + escapedName + '</name>\n';
                kml += '<Point><coordinates>' + obj.lng + ',' + obj.lat + ',0</coordinates></Point>\n';
                kml += '</Placemark>\n';
            }
        );

        kml += '</Document>\n</kml>';

        kmlBlob = new Blob([kml], {
            type: 'application/vnd.google-earth.kml+xml'
        });
        dataDownlodaLinkEl.href = URL.createObjectURL(kmlBlob);
        dataDownlodaLinkEl.download = 'ingress-portals.kml';
        dataDownlodaLinkEl.style.display = 'block';
    };

    // extend portal's GUID lookup to search in offle portals as well
    offle.findPortalGuidByOffleE6 = function(latE6, lngE6) {
        // try looking up using the original IITC function
        let guid = offle.findPortalGuidByPositionE6old(latE6, lngE6);
        //console.log("findPortalGuidByOffleE6[original] %s %s -> %s", latE6, lngE6, guid);

        // if the lookup fails, try locating the portal using the offle database
        if (guid == null) {
            let lat = parseInt(latE6) / 1E6;
            let lng = parseInt(lngE6) / 1E6;
            //console.log("lat/lng parsed as", lat, lng);
            for (let g in offle.portalDb) {
                let p = offle.portalDb[g];
                if (p.lat == lat && p.lng == lng) {
                    //console.log("findPortalGuidByOffleE6[offle] matched! %s %s -> [%s] = %o", latE6, lngE6, g, p);
                    guid = g;
                    break;
                }
            }
        }
        return guid;
    }

    offle.searchInit = function () {
        offle.findPortalGuidByPositionE6old = window.findPortalGuidByPositionE6;
        window.findPortalGuidByPositionE6 = function(lat,lng) { return offle.findPortalGuidByOffleE6(lat, lng) };
        console.log ("findPortalGuidByOffleE6 code injected");
    }

    var setup = function () {
        var API = 'https://unpkg.com/localforage@1.7.3/dist/localforage.js';
        $.getScript(API).done(function () {
            offle.setupLayer();
            offle.setupCSS();
            offle.setupHtml();

            //convert old localStorage database to new localforage
            var db = JSON.parse(localStorage.getItem('portalDb'));
            if (db) {
                localforage.setItem('portalDb', db)
                    .then(function () {
                        console.log('Offle: Db migrated');
                        localStorage.removeItem('portalDb');
                    });
            }

            //load portals from local storage
            localforage.getItem('portalDb').then(
                function (value) {
                    if (value) {
                        offle.portalDb = value;
                        if (Object.keys(offle.portalDb).length > 0) {
                            offle.renderVisiblePortals();
                        } else {
                            offle.portalDb = {};
                        }
                    }
                }
            );

            map.on('movestart', function () {
                offle.clearLayer();
            });
            map.on('moveend', offle.onMapMove);
            window.addHook('portalAdded', offle.portalAdded);
            window.addHook('mapDataRefreshStart', offle.mapDataRefreshStart);
            window.addHook('mapDataRefreshEnd', offle.mapDataRefreshEnd);
            window.addHook('portalDetailsUpdated', offle.portalDetailsUpdated);
        });

        // overload findPortalGuidByPositionE6() core IITC function with one
        // that also searches the offle database
        offle.searchInit();
    };
    // PLUGIN END //////////////////////////////////////////////////////////

    setup.info = plugin_info; //add the script info data to the function as a property
    if (!window.bootPlugins) {
        window.bootPlugins = [];
    }
    window.bootPlugins.push(setup);
    // if IITC has already booted, immediately run the 'setup' function
    if (window.iitcLoaded && typeof setup === 'function') {
        setup();
    }
} // wrapper end
// inject code into site context
var script = document.createElement('script');
var info = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
    info.script = {
        version: GM_info.script.version,
        name: GM_info.script.name,
        description: GM_info.script.description
    };
}
script.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(info) + ');'));
(document.body || document.head || document.documentElement).appendChild(script);