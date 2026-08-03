function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('state-on')[0].innerText = "Interceptor is on. Run `interceptor contexts`; Safari appears while its control-plane connection is live.";
        document.getElementsByClassName('state-off')[0].innerText = "Interceptor is off. Safari requires you to approve it in Extensions settings before `interceptor contexts` can list `safari`.";
        document.getElementsByClassName('state-unknown')[0].innerText = "Enable Interceptor in the Extensions section of Safari Settings. Safari requires you to approve this protected setting.";
        document.getElementsByClassName('open-preferences')[0].innerText = "Quit and Open Safari Settings…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
