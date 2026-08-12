const VIEWS = Object.freeze({
    tour: { title: '游客端', url: '/tour?demo=1' },
    ops: { title: '运营端', url: '/ops?gis=1' },
    screen: { title: '展示大屏', url: '/screen?gis=1' }
});

const tabs = [...document.querySelectorAll('[data-view]')];
const frames = [...document.querySelectorAll('[data-frame]')];
const openView = document.querySelector('[data-open-view]');

function activate(view, { updateUrl = true } = {}) {
    const selected = VIEWS[view] ? view : 'tour';
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.view === selected));
    for (const frame of frames) {
        const active = frame.dataset.frame === selected;
        frame.hidden = !active;
        if (active && !frame.getAttribute('src')) frame.src = frame.dataset.src;
    }
    const config = VIEWS[selected];
    openView.href = config.url;
    document.title = `${config.title} | GeoSync 三端工作台`;
    if (updateUrl) history.replaceState(null, '', `?view=${selected}`);
}

for (const tab of tabs) tab.addEventListener('click', () => activate(tab.dataset.view));
activate(new URLSearchParams(location.search).get('view'), { updateUrl: false });
