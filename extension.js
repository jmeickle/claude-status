import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// GNOME Shell caches ES modules by URL for the whole session. Importing the
// indicator with its mtime in the URL makes disable/enable pick up edits.
async function importIndicator(path) {
    const file = Gio.File.new_for_path(`${path}/indicator.js`);
    const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
    return import(`${file.get_uri()}?mtime=${info.get_modification_date_time().to_unix()}`);
}

export default class ClaudeStatusExtension extends Extension {
    enable() {
        const generation = this._generation = (this._generation ?? 0) + 1;
        importIndicator(this.path).then(({ClaudeIndicator}) => {
            if (generation !== this._generation)
                return;
            this._indicator = new ClaudeIndicator(this);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        }).catch(e => logError(e, 'claude-status: could not load indicator.js'));
    }

    disable() {
        this._generation++;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
