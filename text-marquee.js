// Share a single set of observers across dynamic lists, Radar and the player.
(() => {
    const selector = [
        '.card .info .title', '.card .info .artist',
        '.strip-title', '.strip-artist', '.strip-meta',
        '.track-info .title', '.track-info .artist',
        '.track-details .title', '.track-details .artist',
        '.playlist-nav .list-name', '[data-auto-scroll]',
    ].join(',');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const tracked = new Set();
    let pending = false;

    function schedule() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(refresh);
    }

    const resize = new ResizeObserver(schedule);
    const visibility = new IntersectionObserver(entries => {
        changes.disconnect();
        for (const entry of entries) {
            entry.target.classList.toggle('is-marquee-visible', entry.isIntersecting);
        }
        observeChanges();
    });
    const changes = new MutationObserver(schedule);
    function observeChanges() {
        changes.observe(document.body, {
            subtree: true, childList: true, characterData: true,
            attributes: true, attributeFilter: ['class', 'style', 'hidden'],
        });
    }

    function unwrap(element) {
        const content = element.querySelector(':scope > .auto-marquee-text');
        if (content) content.replaceWith(...content.childNodes);
        element.classList.remove('auto-marquee');
        element.style.removeProperty('--text-slide-distance');
        element.style.removeProperty('--text-slide-duration');
    }

    function refresh() {
        pending = false;
        changes.disconnect();
        for (const element of tracked) {
            if (!element.isConnected) {
                resize.unobserve(element);
                visibility.unobserve(element);
                tracked.delete(element);
            }
        }
        for (const element of document.querySelectorAll(selector)) {
            if (!tracked.has(element)) {
                tracked.add(element);
                resize.observe(element);
                visibility.observe(element);
            }
            // Apply the same overflow loop to Radar and all other views at any width.
            const enabled = !reducedMotion.matches;
            if (!enabled) { unwrap(element); continue; }
            if (!element.clientWidth || !element.getClientRects().length) continue;
            let content = element.querySelector(':scope > .auto-marquee-text');
            const distance = (content ? content.scrollWidth : element.scrollWidth) - element.clientWidth;
            if (distance <= 2) { unwrap(element); continue; }
            if (!content) {
                content = document.createElement('span');
                content.className = 'auto-marquee-text';
                content.append(...element.childNodes);
                element.append(content);
            }
            element.classList.add('auto-marquee');
            element.style.setProperty('--text-slide-distance', `-${Math.ceil(distance)}px`);
            // Scroll left at about 28px/s, pause at the end, then reset on the next loop.
            element.style.setProperty('--text-slide-duration', `${Math.max(3, distance / (28 * 0.7))}s`);
        }
        observeChanges();
    }

    reducedMotion.addEventListener('change', schedule);
    document.fonts?.ready.then(schedule);
    schedule();
})();
