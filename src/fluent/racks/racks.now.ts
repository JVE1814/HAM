import '@servicenow/sdk/global'
import { Acl, BusinessRule, Record, UiPage } from '@servicenow/sdk/core'
import { RACK_PAGE_USERS } from '../../server/domain/roles'
import { PLACEMENT_FIELDS } from '../../server/domain/rack'
import { explainRackRefusal } from '../../server/entry/racks'
import { recheckRacksOf } from '../../server/platform/racks'
import { CURRENT_IS_FLEET, CURRENT_IS_FLEET_UNSPACED, FLEET_FIELD } from '../../server/domain/fleet'
import rackPage from '../../client/rack.html'
import { ENTRY_MODULES } from '../shared/server-modules.now'
import { providerStaff } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

/** Written without spaces, as the rack rules' conditions are. */
const PLACEMENT_SET = `current.${PLACEMENT_FIELDS.rack}.changes()||current.${PLACEMENT_FIELDS.ruStart}.changes()||current.${PLACEMENT_FIELDS.face}.changes()`

// alm_hardware is a global table: the platform refuses current.setAbortAction from this scope and saves anyway, so
// the rule refuses with its Abort action when the condition (the module's check) holds; the script only says why. The
// platform runs the condition on every save, whatever the rule's filter, so its change test keeps the module unloaded
// on other saves, and the Fleet flag right after it keeps the Provider IT's equipment out (ADR 0016). The condition
// field holds at most 254 characters: so this one is written without spaces, and a racked Asset's new Model or joining
// the fleet, which would not fit beside the rest, has a rule of its own below. This one checks every save that sets
// the placement (an insert with a rack, a new rack, lowest unit or face), with whatever Model the save gives the Asset
// and as new to the rack when it joins the fleet with that save, so the other leaves those saves to it: each save is
// checked, and refused, once.
BusinessRule({
    $id: Now.ID['br_rack_placement'],
    name: 'NaaS - check rack placement and power',
    table: 'alm_hardware',
    when: 'before',
    action: ['insert', 'update'],
    order: 150,
    condition:
        `(${PLACEMENT_SET})&&${CURRENT_IS_FLEET_UNSPACED}&&require('${ENTRY_MODULES}/racks.ts').refusesRackPlacement(current,previous)`,
    abortAction: true,
    script: explainRackRefusal,
})

// The same check when a racked Asset keeps its placement and gets a new Model (its height and power change) or joins
// the fleet: "Add to fleet" saves the form first, while the unit is outside the fleet and no rule checks it, then
// changes only the flag, so its placement is checked as one new to the rack. A
// save that also sets the placement is the rule above's. An update only, as an insert with a rack sets the placement.
BusinessRule({
    $id: Now.ID['br_rack_placement_model'],
    name: 'NaaS - racked asset must fit its rack',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 150,
    condition:
        `(current.model.changes() || current.${FLEET_FIELD}.changes()) && ${CURRENT_IS_FLEET} && current.${PLACEMENT_FIELDS.rack} != '' && require('${ENTRY_MODULES}/racks.ts').refusesKeptPlacement(current, previous)`,
    abortAction: true,
    script: explainRackRefusal,
})

// The before rules check the placements saved so far; this one re-checks the racks once the save is written, for two
// saves at the same moment that both passed them, a racked unit joining the fleet among them. Written without spaces
// to fit the 254 characters.
BusinessRule({
    $id: Now.ID['br_rack_recheck'],
    name: 'NaaS - re-check rack overlaps and power',
    table: 'alm_hardware',
    when: 'after',
    action: ['insert', 'update'],
    order: 150,
    condition:
        `(${PLACEMENT_SET}||((current.model.changes()||current.${FLEET_FIELD}.changes())&&current.${PLACEMENT_FIELDS.rack}!=''))&&${CURRENT_IS_FLEET_UNSPACED}`,
    script: recheckRacksOf,
})

/** The rack page's name: its address is this with .do, and its ACL is named by it. */
export const RACKS_PAGE = 'x_daas_ham_racks'

UiPage({
    $id: Now.ID['page_racks'],
    endpoint: `${RACKS_PAGE}.do`,
    description: 'Front and rear rack elevations per site, coloured by stage, customer or EoX / coverage risk.',
    category: 'general',
    html: rackPage,
    direct: true,
})

Acl({
    $id: Now.ID['acl_page_racks'],
    type: 'ui_page',
    name: RACKS_PAGE,
    operation: 'read',
    roles: RACK_PAGE_USERS,
})

Record({
    $id: Now.ID['module_racks'],
    table: 'sys_app_module',
    data: {
        title: 'Rack elevations',
        application: naasMenu,
        link_type: 'DIRECT',
        query: `${RACKS_PAGE}.do`,
        roles: providerStaff,
        active: true,
        order: 130,
    },
})
