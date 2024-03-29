import { getSetting } from "./lib/lib.js";
import CONSTANTS from "./constants.js";
import PromptRestDialog from "./formapplications/prompt-rest/prompt-rest.js";

export default function registerHooks(){

  Hooks.on("renderPlayerList", (app, html) => {

    if (!game.user.isGM || !getSetting(CONSTANTS.SETTINGS.SHOW_PLAYER_LIST_REST_BUTTON)) return;

    const minimalUI = game.modules.get('minimal-ui')?.active;
    const itemPiles = game.modules.get('item-piles')?.active;

    const classes = "rest-recovery-prompt-rest-button" + (minimalUI ? " minimal-ui-button" : "");

    let parent = html;
    const tradeButton = html.find(".item-piles-player-list-trade-button");
    if (itemPiles && tradeButton.length && !minimalUI) {
      tradeButton.html(`<i class="fas fa-handshake"></i> Trade`);
      tradeButton.addClass(classes);
      parent = $(`<div class="rest-recovery-button-parent"></div>`);
      parent.append(tradeButton);
      html.append(parent);
    }
    const text = !minimalUI ? (itemPiles && tradeButton.length ? "Rest" : "Prompt Rest") : "";
    const button = $(`<button type="button" class="${classes}"><i class="fas fa-bed"></i>${text}</button>`);

    button.click(() => {
      PromptRestDialog.show();
    });

    parent.append(button);

  });

}
