import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// GObject type names are global for the whole shell session; a fresh suffix
// per module load lets disable/enable re-import an edited file.
const LOAD_ID = Date.now();

const REFRESH_SECONDS = 300;
const TICK_SECONDS = 1;
const BAR_WIDTH = 220;

// The cheapest possible request: every API response carries the account's
// unified rate-limit utilization and reset times as headers.
const API_URL = 'https://api.anthropic.com/v1/messages';
const PROBE_BODY = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    messages: [{role: 'user', content: 'hi'}],
});

function colorForPercent(pct) {
    if (pct >= 80)
        return '#e74c3c';
    if (pct >= 50)
        return '#f1c40f';
    return '#2ecc71';
}

function formatCountdown(resetDate, now) {
    if (!resetDate)
        return '--';
    let diff = resetDate.getTime() - now.getTime();
    if (diff < 0)
        diff = 0;

    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);

    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function readJson(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

// The token Claude Code itself uses: a long-lived one from `claude setup-token`
// in the user settings env, else the interactive login's access token.
function readToken() {
    const home = GLib.get_home_dir();
    const fromSettings = readJson(`${home}/.claude/settings.json`)?.env?.CLAUDE_CODE_OAUTH_TOKEN;
    if (fromSettings)
        return fromSettings;
    return readJson(`${home}/.claude/.credentials.json`)?.claudeAiOauth?.accessToken || null;
}

function parseWindow(headers, window) {
    const utilization = parseFloat(headers.get_one(`anthropic-ratelimit-unified-${window}-utilization`));
    const reset = parseInt(headers.get_one(`anthropic-ratelimit-unified-${window}-reset`), 10);
    if (Number.isNaN(utilization) || Number.isNaN(reset))
        return null;
    return {
        pct: Math.round(utilization * 100),
        resetDate: new Date(reset * 1000),
        resetText: GLib.DateTime.new_from_unix_local(reset).format('%b %-d, %-I:%M%P'),
    };
}

const UsageCard = GObject.registerClass({GTypeName: `ClaudeStatusUsageCard${LOAD_ID}`},
class UsageCard extends St.BoxLayout {
    _init(title, gettext) {
        super._init({vertical: true, style_class: 'claude-card', x_expand: true});
        this._ = gettext;

        this.add_child(new St.Label({text: title, style_class: 'claude-card-title'}));

        this._pctLabel = new St.Label({text: '--%', style_class: 'claude-card-pct'});
        this.add_child(this._pctLabel);

        this._barBg = new St.Widget({style_class: 'claude-bar-bg', width: BAR_WIDTH, height: 10});
        this._barFill = new St.Widget({style_class: 'claude-bar-fill', height: 10});
        this._barBg.add_child(this._barFill);
        this.add_child(this._barBg);

        this._resetLabel = new St.Label({text: '', style_class: 'claude-card-reset'});
        this.add_child(this._resetLabel);

        this._countdownLabel = new St.Label({text: '', style_class: 'claude-card-countdown'});
        this.add_child(this._countdownLabel);
    }

    setData(pct, resetText) {
        this._pctLabel.set_text(`${pct}%`);
        this._pctLabel.set_style(`color: ${colorForPercent(pct)};`);

        const width = Math.round((BAR_WIDTH * Math.min(pct, 100)) / 100);
        this._barFill.set_width(width);
        this._barFill.set_style(`background-color: ${colorForPercent(pct)};`);

        // TRANSLATORS: %s is a date/time string, e.g. "Jul 23, 7:40pm"
        this._resetLabel.set_text(this._('Resets at · %s').replace('%s', resetText));
    }

    setEmpty() {
        this._pctLabel.set_text('--%');
        this._pctLabel.set_style('');
        this._barFill.set_width(0);
        this._resetLabel.set_text('');
        this._countdownLabel.set_text('');
    }

    setCountdown(text) {
        this._countdownLabel.set_text(text);
    }
});

export const ClaudeIndicator = GObject.registerClass({GTypeName: `ClaudeStatusIndicator${LOAD_ID}`},
class ClaudeIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, extension.gettext('Claude Status'));

        this._ = s => extension.gettext(s);
        this._extension = extension;
        this._lastUpdate = null;
        this._data = null;
        this._error = null;
        this._refreshing = false;
        this._session = new Soup.Session({timeout: 30});
        this._cancellable = new Gio.Cancellable();

        const box = new St.BoxLayout({style_class: 'claude-panel-box'});

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/claude-ai-symbol.svg`),
            style_class: 'system-status-icon',
        });
        box.add_child(this._icon);

        this._label = new St.Label({
            text: this._panelLabel('--%', '--%'),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-panel-label',
        });
        box.add_child(this._label);

        this.add_child(box);

        this._buildMenu();
        this._refresh();

        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });

        this._tickTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _panelLabel(sessionText, weekText) {
        const ext = this._extension;
        const sessionAbbr = ext.pgettext('short abbreviation for "session" shown in the top bar', 'S');
        const weekAbbr = ext.pgettext('short abbreviation for "week" shown in the top bar', 'W');
        return `${sessionAbbr} ${sessionText} | ${weekAbbr} ${weekText}`;
    }

    _buildMenu() {
        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const headerBox = new St.BoxLayout({style_class: 'claude-header', x_expand: true});

        headerBox.add_child(new St.Label({
            text: 'Claude Code',
            style_class: 'claude-header-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._updatedLabel = new St.Label({
            text: '',
            style_class: 'claude-header-updated',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(this._updatedLabel);

        const refreshBtn = new St.Button({
            style_class: 'claude-refresh-btn',
            child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 14}),
        });
        refreshBtn.connect('clicked', () => this._refresh());
        headerBox.add_child(refreshBtn);

        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const cardsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const cardsBox = new St.BoxLayout({style_class: 'claude-cards-box', x_expand: true});

        this._sessionCard = new UsageCard(this._('SESSION (5h)'), this._);
        this._weekCard = new UsageCard(this._('WEEK'), this._);
        cardsBox.add_child(this._sessionCard);
        cardsBox.add_child(this._weekCard);

        cardsItem.add_child(cardsBox);
        this.menu.addMenuItem(cardsItem);

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._tick();
        });
    }

    _tick() {
        const now = new Date();

        if (this._data) {
            if (this._data.session)
                this._sessionCard.setCountdown(formatCountdown(this._data.session.resetDate, now));
            if (this._data.week)
                this._weekCard.setCountdown(formatCountdown(this._data.week.resetDate, now));
        }

        if (!this.menu.isOpen)
            return;
        if (this._error) {
            this._updatedLabel.set_text(this._error);
        } else if (this._lastUpdate) {
            const secs = Math.max(0, Math.round((now - this._lastUpdate) / 1000));
            // TRANSLATORS: %d is the number of seconds since the last refresh
            this._updatedLabel.set_text(this._('updated %ds ago').replace('%d', secs));
        }
    }

    _fail(message) {
        this._error = message;
        console.error(`claude-status: ${message}`);
        this._tick();
    }

    _refresh() {
        if (this._refreshing)
            return;

        const token = readToken();
        if (!token) {
            this._fail('no Claude Code token found');
            return;
        }

        const msg = Soup.Message.new('POST', API_URL);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        msg.request_headers.append('anthropic-version', '2023-06-01');
        msg.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(PROBE_BODY)));

        this._refreshing = true;
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable, (session, res) => {
            this._refreshing = false;
            try {
                session.send_and_read_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._fail(`request failed: ${e.message}`);
                return;
            }

            const headers = msg.get_response_headers();
            const sessionWindow = parseWindow(headers, '5h');
            const weekWindow = parseWindow(headers, '7d');
            if (!sessionWindow && !weekWindow) {
                this._fail(`HTTP ${msg.get_status()} without rate-limit headers`);
                return;
            }

            this._data = {session: sessionWindow, week: weekWindow};
            this._error = null;
            this._lastUpdate = new Date();

            this._label.set_text(this._panelLabel(
                sessionWindow ? `${sessionWindow.pct}%` : '--%',
                weekWindow ? `${weekWindow.pct}%` : '--%'));
            if (sessionWindow)
                this._sessionCard.setData(sessionWindow.pct, sessionWindow.resetText);
            else
                this._sessionCard.setEmpty();
            if (weekWindow)
                this._weekCard.setData(weekWindow.pct, weekWindow.resetText);
            else
                this._weekCard.setEmpty();
            this._tick();
        });
    }

    destroy() {
        this._cancellable.cancel();
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = null;
        }
        if (this._tickTimer) {
            GLib.source_remove(this._tickTimer);
            this._tickTimer = null;
        }
        super.destroy();
    }
});
