import CONSTANTS from "./constants.js";
import { determineLongRestMultiplier, determineRoundingMethod } from "./lib/lib.js";

const rests = new Map();

export default class RestWorkflow {

    static get(actor) {
        return rests.get(actor.uuid);
    }

    static remove(actor){
        return rests.delete(actor.uuid);
    }

    static make(actor, longRest = false) {
        this.remove(actor);
        const workflow = new this(actor, longRest);
        rests.set(actor.uuid, workflow);
        return workflow;
    }

    constructor(actor, longRest) {
        this.actor = actor;
        this.longRest = longRest;
        this.fetchHealthData();
        this.fetchSpellData();
        this.fetchFeatures();
    }

    get healthPercentage(){
        return this.actor.data.data.attributes.hp.value / this.actor.data.data.attributes.hp.max;
    }

    get healthRegained(){
        return this.actor.data.data.attributes.hp.value - this.healthData.startingHealth;
    }

    get totalHitDice(){
        return this.actor.data.data.attributes.hd;
    }

    get recoveredSlots(){
        return Object.fromEntries(Object.entries(this.spellData.slots).map(entry => {
            return [entry[0], entry[1] ? entry[1].reduce((acc, slot) => {
                return acc + (slot.empty && slot.checked ? 1 : 0);
            }, 0) : 0]
        }).filter(entry => entry[1]));
    }

    fetchHealthData(){
        this.healthData = {
            startingHitDice: this.actor.data.data.attributes.hd,
            startingHealth: this.actor.data.data.attributes.hp.value,
            availableHitDice: this.getHitDice(),
            totalHitDice: this.totalHitDice
        }
    }

    getHitDice(){
        return this.actor.data.items.reduce((hd, item) => {
            if ( item.type === "class" ) {
                const d = item.data.data;
                const denom = d.hitDice || "d6";
                const available = parseInt(d.levels || 1) - parseInt(d.hitDiceUsed || 0);
                hd[denom] = denom in hd ? hd[denom] + available : available;
            }
            return hd;
        }, {});
    }

    fetchSpellData(){

        this.spellData = {
            slots: {},
            missingSlots: false,
            feature: false,
            pointsSpent: 0,
            pointsTotal: 0,
            className: ""
        };

        const wizardLevel = this.actor.items.find(item => {
            return item.type === "class"
                && item.data.data.levels >= 2
                && (item.name === game.i18n.localize("REST-RECOVERY.ClassNames.Wizard"));
        })?.data?.data?.levels || 0;
        const wizardFeature = this.actor.items.getName(game.i18n.localize("REST-RECOVERY.FeatureNames.ArcaneRecovery")) || false;

        const druidLevel = this.actor.items.find(item => {
            return item.type === "class"
                && item.data.data.levels >= 2
                && (item.name === game.i18n.localize("REST-RECOVERY.ClassNames.Druid"));
        })?.data?.data?.levels || 0;
        const druidFeature = this.actor.items.getName(game.i18n.localize("REST-RECOVERY.FeatureNames.DruidRecovery")) ?? false;

        for (let [level, slot] of Object.entries(this.actor.data.data.spells)) {
            if((!slot.max && !slot.override) || level === "pact"){
                continue;
            }
            let levelNum = Number(level.substr(5))
            if(Number(levelNum) > 5){
                break;
            }
            this.spellData.slots[levelNum] = [];
            for(let i = 0; i < slot.max; i++){
                this.spellData.slots[levelNum].push({
                    checked: i < slot.value,
                    disabled: false,
                    alwaysDisabled: i < slot.value,
                    empty: i >= slot.value
                });
                this.spellData.missingSlots = this.spellData.missingSlots || i >= slot.value;
            }
        }

        const wizardFeatureUse = wizardLevel && wizardFeature && wizardFeature?.data?.data?.uses?.value > 0;
        const druidFeatureUse = druidLevel && druidFeature && druidFeature?.data?.data?.uses?.value > 0;

        if(wizardLevel > druidLevel || (druidLevel > wizardLevel && !druidFeatureUse)){
            this.spellData.has_feature_use = wizardFeatureUse;
            this.spellData.feature = wizardFeature;
            this.spellData.pointsTotal = Math.ceil(wizardLevel/2);
            this.spellData.className = game.i18n.localize("REST-RECOVERY.ClassNames.Wizard");
        }else if(druidLevel > wizardLevel || (wizardLevel > druidLevel && !wizardFeatureUse)){
            this.spellData.has_feature_use = druidFeatureUse;
            this.spellData.feature = druidFeature;
            this.spellData.pointsTotal = Math.ceil(druidLevel/2);
            this.spellData.className = game.i18n.localize("REST-RECOVERY.ClassNames.Druid");
        }


        this.patchSpellFeature();

    }

    async patchSpellFeature(){
        if(this.spellData.feature &&
            (
                this.spellData.feature.data.data.activation.type !== "special" ||
                this.spellData.feature.data.data.uses.value === null ||
                this.spellData.feature.data.data.uses.max === null ||
                this.spellData.feature.data.data.uses.per !== "lr"
            )
        ){
            await this.actor.updateEmbeddedDocuments("Item", [{
                _id: this.spellData.feature.id,
                "data.activation.type": "special",
                "data.uses.value": 1,
                "data.uses.max": 1,
                "data.uses.per": "lr",
            }]);
            ui.notifications.info(game.i18n.format("REST-RECOVERY.PatchedRecovery", {
                actorName: this.actor.name,
                recoveryName: this.spellData.feature.name
            }));
        }
    }

    fetchFeatures(){

        this.features = {
            bard: false,
            bardLevel: false,
            songOfRest: false,
            usedSongOfRest: false,
            chef: false,
            usedChef: false,
            usedAllFeatures: false,
            periapt: false,
            durable: false
        }

        const ignoreInactivePlayers = game.settings.get(CONSTANTS.MODULE_NAME, CONSTANTS.SETTINGS.IGNORE_INACTIVE_PLAYERS);

        let characters = game.actors.filter(actor => actor.data.type === "character" && actor.hasPlayerOwner);
        for(let actor of characters){

            // Only consider the actor if it has more than 0 hp, as features cannot be used if they are unconscious
            if(actor.data.data.attributes.hp.value <= 0) continue;

            if(ignoreInactivePlayers) {
                let found = game.users.find(user => {
                    return actor === user.character && user.active;
                })
                if(!found) continue;
            }

            const songOfRest = actor.items.getName(game.i18n.format("REST-RECOVERY.FeatureNames.SongOfRest"));
            if(songOfRest){
                const bardClass = actor.items.find(item => item.type === "class" && item.name === game.i18n.format("REST-RECOVERY.ClassNames.Bard"));
                if(bardClass){
                    const level = bardClass.data.data.levels;
                    this.features.bard = this.features.bardLevel > level ? this.features.bard : actor;
                    this.features.bardLevel = this.features.bardLevel > level ? this.features.bardLevel : level;

                    if(this.features.bardLevel >= 17){
                        this.features.songOfRest = "1d12";
                    }else if(this.features.bardLevel >= 13){
                        this.features.songOfRest = "1d10";
                    }else if(this.features.bardLevel >= 9){
                        this.features.songOfRest = "1d8";
                    }else if(this.features.bardLevel >= 2){
                        this.features.songOfRest = "1d6";
                    }
                }
            }

            const chefFeat = actor.items.getName(game.i18n.format("REST-RECOVERY.FeatureNames.ChefFeat"));
            const chefTools = actor.items.getName(game.i18n.format("REST-RECOVERY.FeatureNames.ChefTools"));
            if(chefFeat && chefTools){
                if(!this.features.chef){
                    this.features.chef = [];
                }
                this.features.chef.push(actor);
            }

        }

    }

    async rollHitDice(hitDice, dialog){
        const roll = await this.actor.rollHitDie(hitDice, { dialog });
        if(!roll) return;
        this.healthData.availableHitDice = this.getHitDice();
        this.healthData.totalHitDice = this.totalHitDice;

        if(this.longRest) return true;

        let hpRegained = 0;

        if(this.features.songOfRest && !this.features.usedSongOfRest){
            const roll = new Roll(this.features.songOfRest).evaluate({ async: false });
            hpRegained += roll.total;

            const isOwnBard = this.features.bard === this.actor;
            await roll.toMessage({
                flavor: game.i18n.format("REST-RECOVERY.Chat.SongOfRest" + (isOwnBard ? "Self" : ""), {
                    name: this.actor.name,
                    bard: this.features.bard.name
                }),
                speaker: ChatMessage.getSpeaker({ actor: this.actor })
            })

            this.features.usedSongOfRest = true;
        }

        if(this.features.chef.length > 0 && !this.features.usedChef){

            const chefActor = this.features.chef[Math.floor(Math.random() * this.features.chef.length)];
            const roll = new Roll('1d8').evaluate({ async: false });
            hpRegained += roll.total;

            const isOwnChef = this.features.bard === this.actor;
            await roll.toMessage({
                flavor: game.i18n.format("REST-RECOVERY.Chat.Chef" + (isOwnChef ? "Self" : ""), {
                    name: this.actor.name,
                    chef: chefActor.name
                }),
                speaker: ChatMessage.getSpeaker({ actor: this.actor })
            })

            this.features.usedChef = true;

        }

        if(hpRegained > 0){
            const curHP = this.actor.data.data.attributes.hp.value;
            const maxHP = this.actor.data.data.attributes.hp.max + (this.actor.data.data.attributes.hp.tempmax ?? 0);
            await this.actor.update({ "data.attributes.hp.value": Math.min(maxHP, curHP + hpRegained)})
        }

        return true;

    }

    spendSpellPoint(level, add){
        this.spellData.pointsSpent += Number(level) * (add ? 1 : -1);
        const pointsLeft = this.spellData.pointsTotal - this.spellData.pointsSpent;
        for(let level of Object.keys(this.spellData.slots)){
            for(let i = 0; i < this.spellData.slots[level].length; i++){
                const slot = this.spellData.slots[level][i];
                this.spellData.slots[level][i].disabled = slot.alwaysDisabled || (Number(level) > pointsLeft && !slot.checked);
            }
        }
    }

    static wrapperFn(actor, wrapped, args, fnName, runWrap = true){

        const workflow = this.get(actor);

        if(!runWrap){
            if(workflow && workflow[fnName]){
                return wrapped(workflow[fnName](args));
            }
            return wrapped(args);
        }

        let updates = wrapped(args);
        if(workflow && workflow[fnName]) {
            updates = workflow[fnName](updates, args);
        }

        return updates;

    }

    _getRestHitPointRecovery(result){

        if(!this.longRest) return result;

        const multiplier = determineLongRestMultiplier(CONSTANTS.SETTINGS.HP_MULTIPLIER);

        const maxHP = this.actor.data.data.attributes.hp.max;
        const recoveredHP = Math.floor(maxHP * multiplier);

        result.updates["data.attributes.hp.value"] = Math.min(maxHP, this.healthData.startingHealth + recoveredHP);
        result.hitPointsRecovered = Math.min(maxHP - this.healthData.startingHealth, recoveredHP);

        return result;

    }

    _getRestHitDiceRecovery({ maxHitDice = undefined }={}){

        if(!this.longRest) return {};

        const multiplier = determineLongRestMultiplier(CONSTANTS.SETTINGS.HD_MULTIPLIER);
        const roundingMethod = determineRoundingMethod(CONSTANTS.SETTINGS.HD_ROUNDING);
        const actorLevel = this.actor.data.data.details.level;

        maxHitDice = Math.clamped(
            roundingMethod(actorLevel * multiplier),
            multiplier ? 1 : 0,
            maxHitDice ?? actorLevel
        );

        return { maxHitDice };

    }

    _getRestResourceRecovery(updates, {recoverShortRestResources=true, recoverLongRestResources=true}={}){

        const multiplier = determineLongRestMultiplier(CONSTANTS.SETTINGS.RESOURCES_MULTIPLIER);

        if(multiplier === 1.0) return updates;
        if(!multiplier) return {};

        updates = {};

        for ( const [key, resource] of Object.entries(this.actor.data.data.resources) ) {
            if (Number.isNumeric(resource.max)) {
                if (recoverShortRestResources && resource.sr) {
                    updates[`data.resources.${key}.value`] = Number(resource.max);
                } else if (recoverLongRestResources && resource.lr) {
                    const recoverResources = Math.max(Math.floor(resource.max * multiplier), multiplier ? 1 : 0);
                    updates[`data.resources.${key}.value`] = Math.min(resource.value + recoverResources, resource.max);
                }
            }
        }

        return updates;

    }

    _getRestSpellRecovery(updates, { recoverSpells=true }={}){

        if(!recoverSpells && this.spellData.feature) {
            for (const [slot, num] of Object.entries(this.recoveredSlots)) {
                const prop = `data.spells.spell${slot}.value`;
                updates[prop] = (updates[prop] || foundry.utils.getProperty(this.actor.data, prop) || 0) + num;
            }
            return updates;
        }

        const multiplier = determineLongRestMultiplier(CONSTANTS.SETTINGS.SPELLS_MULTIPLIER);

        for ( let [level, slot] of Object.entries(this.actor.data.data.spells) ) {
            if (!slot.override && !slot.max) continue;
            let spellMax = slot.override || slot.max;
            let recoverSpells = Math.max(Math.floor(spellMax * multiplier), multiplier ? 1 : multiplier);
            updates[`data.spells.${level}.value`] = Math.min(slot.value + recoverSpells, spellMax);
            this.spellData.slots[level] = Math.min(slot.value + recoverSpells, spellMax);
        }

        return updates;

    }

    _getRestItemUsesRecovery(updates, args){

        if(this.longRest) {
            return this.recoverItemsUses(updates, args);
        }

        if (this.spellData.pointsSpent && this.spellData.feature) {
            updates.push({ _id: this.spellData.feature.id, "data.uses.value": 0 });
        }

        return updates;

    }

    recoverItemsUses(updates, args){
        const { recoverLongRestUses, recoverDailyUses } = args;

        const featsMultiplier = determineLongRestMultiplier(CONSTANTS.SETTINGS.USES_FEATS_MULTIPLIER);
        const othersMultiplier = determineLongRestMultiplier(CONSTANTS.SETTINGS.USES_OTHERS_MULTIPLIER);
        const dailyMultiplier = determineLongRestMultiplier(CONSTANTS.SETTINGS.USES_DAILY_MULTIPLIER);

        for(const item of this.actor.items) {
            if (item.data.data.uses) {
                if (recoverLongRestUses && item.data.data.uses.per === "lr") {
                    updates = this.recoverItemUse(updates, item, item.type === "feat" ? featsMultiplier : othersMultiplier);
                } else if (recoverDailyUses && item.data.data.uses.per === "day") {
                    updates = this.recoverItemUse(updates, item, dailyMultiplier);
                }
            } else if (recoverLongRestUses && item.data.data.recharge && item.data.data.recharge.value) {
                updates.push({ _id: item.id, "data.recharge.charged": true });
            }
        }

        return updates;
    }


    recoverItemUse(updates, item, multiplier){

        const usesMax = item.data.data.uses.max;
        const usesCur = item.data.data.uses.value;

        const amountToRecover = Math.max(Math.floor(usesMax * multiplier), multiplier ? 1 : 0);

        const update = updates.find(update => update._id === item.id);

        const recoverValue = Math.min(usesCur + amountToRecover, usesMax);

        if(update){
            update["data.uses.value"] = recoverValue;
        }else{
            updates.push({
                _id: item.id,
                "data.uses.value": recoverValue
            });
        }

        return updates;

    }

}