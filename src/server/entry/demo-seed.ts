import { GlideRecord, gs } from '@servicenow/glide'
import { newAsset } from '../platform/assets.ts'
import { writeModelLifecycle } from '../platform/model-lifecycle.ts'
import { findById, refusal, str } from '../platform/records.ts'
import type { Stage } from '../domain/lifecycle.ts'
import type { CatalogEntryType, DeviceClass } from '../domain/vocabulary.ts'
import { fleetCondition, OEM_PID_FIELD, SITE_FIELD, STOCKROOM_TYPE_FIELD } from '../domain/fleet.ts'
import { ROLE } from '../domain/roles.ts'
import { stringProperty } from '../platform/properties.ts'
import { PROPERTY } from '../domain/properties.ts'
import { log } from '../platform/log.ts'

/**
 * Demo data for dev/test instances: two Customers with Sites, racks and stockrooms, models from the
 * four vendors, site templates, agreements, subscription lines, catalog entries, staging checklists,
 * demo users and stock. Run the "NaaS - load demo data" job, which the SDK installs unless the app is
 * installed with `now-sdk install --no-demoData` (as on production); it refuses an instance in use
 * (`demoRefusal`). Idempotent: records are looked up by a natural key before they are created.
 * Lifecycle dates are illustrative, not vendor EoX bulletins.
 */

type Fields = { [field: string]: string | number | boolean }

function ensure(table: string, key: Fields, fields: Fields = {}): string {
    const gr = new GlideRecord(table)
    for (const [field, value] of Object.entries(key)) gr.addQuery(field, value)
    gr.setLimit(1)
    gr.query()
    if (gr.next()) return gr.getUniqueValue()
    gr.initialize()
    for (const [field, value] of Object.entries({ ...key, ...fields })) gr.setValue(field, value)
    const id = gr.insert()
    if (id) return id
    log.warn(`Demo ${table} ${JSON.stringify(key)} not created: ${refusal(gr)}`)
    return ''
}

function save(record: GlideRecord, what: string): void {
    if (!record.update()) log.warn(`Demo ${what} not saved: ${refusal(record)}`)
}

function setDemoProperty(name: string, recordId: string): void {
    if (recordId) return void gs.setProperty(name, recordId)
    log.warn(`${name} not set: its demo record was not created`)
}

const ADMIN_USER = '6816f79cc0a8016401c5a33be04be441'

/** The group the demo depots are assigned to. It ships with the demo data (fluent/demo): this scope may not create a group. */
export const DEMO_DEPOT_GROUP = 'NaaS demo depot team'

const DEMO_PROVIDER = 'Demo NaaS Provider'

/**
 * Why the demo data must not load here, or null. It is for dev/test instances, and it sets the app's Provider and
 * default staging stockroom to its own and adds demo Customers, users with roles, and stock. An instance whose Provider
 * (x_daas_ham.provider_company) is set to a company other than the demo's is in use, as a production instance is, so
 * nothing is loaded there. (glide.installation.production cannot tell: a personal developer instance reports true.)
 */
function demoRefusal(): string | null {
    const providerId = stringProperty(PROPERTY.providerCompany)
    if (!providerId) return null
    const provider = findById('core_company', providerId)
    if (provider && str(provider, 'name') === DEMO_PROVIDER) return null
    const named = provider ? str(provider, 'name') : `${providerId}, no company`
    return `its Provider (${PROPERTY.providerCompany.name}) is ${named}, not ${DEMO_PROVIDER}: the instance is in use. Clear the property to load the demo data on a dev/test instance`
}

/** A demo Agreement loaded before Agreements had a currency bills in EUR, as its lines did; a refused save is logged. */
function keepCurrency(agreementId: string): void {
    const agreement = findById('x_daas_ham_agreement', agreementId)
    if (!agreement || str(agreement, 'currency')) return
    agreement.setValue('currency', 'EUR')
    save(agreement, `agreement ${str(agreement, 'short_description')} (its currency)`)
}

/** The sys_id of the Model category named `name` (base system data), or '' (logged): its demo Models then get none. */
function findCategory(name: string): string {
    const category = new GlideRecord('cmdb_model_category')
    if (category.get('name', name)) return category.getUniqueValue()
    log.warn(`Demo Model category ${name} not found: its demo Models get none, and no purchase order is raised for them`)
    return ''
}

/**
 * A demo Model loaded before the demo data set Model categories gets its category; one already set is kept. Found by
 * its OEM PID, as a NaaS Model is (ADR 0016); a refused save is logged.
 */
function keepCategory(pid: string, categoryId: string): void {
    if (!categoryId) return
    const model = new GlideRecord('cmdb_hardware_product_model')
    model.addQuery(OEM_PID_FIELD, pid)
    model.addNullQuery('cmdb_model_category')
    model.query()
    while (model.next()) {
        model.setValue('cmdb_model_category', categoryId)
        save(model, `model ${pid} (its Model category)`)
    }
}

export function loadDemoData(): void {
    const refused = demoRefusal()
    if (refused) return void log.error(`Demo data not loaded: ${refused}`)
    const provider = ensure('core_company', { name: DEMO_PROVIDER })
    setDemoProperty(PROPERTY.providerCompany.name, provider)

    const vendor = (name: string) => ensure('core_company', { name }, { manufacturer: true, vendor: true })
    const cisco = vendor('Cisco Systems')
    const hpe = vendor('Hewlett Packard Enterprise')
    const fortinet = vendor('Fortinet')
    const checkpoint = vendor('Check Point Software Technologies')

    const customer = (name: string, number: string) => ensure('customer_account', { name }, { customer: true, number })
    const acme = customer('Acme Retail (demo)', 'ACCT-DEMO-ACME')
    const globex = customer('Globex Logistics (demo)', 'ACCT-DEMO-GLOBEX')

    const site = (name: string, company: string, city: string) =>
        ensure('cmn_location', { name }, { company, city, [SITE_FIELD]: true })
    const acmeHq = site('Acme HQ Amsterdam', acme, 'Amsterdam')
    site('Acme Store 042 Utrecht', acme, 'Utrecht')
    const globexDc = site('Globex DC Frankfurt', globex, 'Frankfurt')
    const acmeMdf = ensure('cmn_location', { name: 'Acme HQ Amsterdam - MDF' }, { parent: acmeHq, company: acme })
    const globexHall = ensure('cmn_location', { name: 'Globex DC Frankfurt - Hall A' }, { parent: globexDc, company: globex })
    const acmeRack = ensure('cmdb_ci_rack', { name: 'ACME-HQ-MDF-R01' }, { location: acmeMdf, company: acme, rack_units: 42, x_daas_ham_power_capacity_w: 3000 })
    ensure('cmdb_ci_rack', { name: 'GLX-FRA-A-R12' }, { location: globexHall, company: globex, rack_units: 47, x_daas_ham_power_capacity_w: 6000 })

    const stockroom = (name: string, type: string, extra: Fields = {}) =>
        ensure('alm_stockroom', { name }, { [STOCKROOM_TYPE_FIELD]: type, ...extra })
    const depot = stockroom('Central Depot Utrecht', 'central_depot')
    const stagingCentre = stockroom('Staging Centre Utrecht', 'staging_centre')
    const acmeSpares = stockroom('Acme HQ hot spares', 'customer_site', { x_daas_ham_customer: acme, location: acmeMdf })
    setDemoProperty(PROPERTY.stagingStockroom.name, stagingCentre)

    const sourceOf = new Map([[cisco, 'cisco'], [hpe, 'aruba'], [fortinet, 'fortinet'], [checkpoint, 'checkpoint']])
    // Procurement refuses a purchase order line item for a Model without a Model category. Modules, power supplies and
    // optics take Hardware: under Network Gear each would become a network device CI of its own.
    const networkGear = findCategory('Network Gear')
    const hardware = findCategory('Hardware')
    const categoryOf = {
        switch: networkGear,
        ap: networkGear,
        router: networkGear,
        firewall: networkGear,
        module: hardware,
        psu: hardware,
        optic: hardware,
    } satisfies Partial<Record<DeviceClass, string>>
    const model = (pid: string, name: string, manufacturer: string, deviceClass: keyof typeof categoryOf, power = 0) => {
        const category = categoryOf[deviceClass]
        const id = ensure(
            'cmdb_hardware_product_model',
            { [OEM_PID_FIELD]: pid },
            {
                name,
                model_number: pid,
                manufacturer,
                cmdb_model_category: category,
                x_daas_ham_device_class: deviceClass,
                power_consumption: power,
                x_daas_ham_oem_source: pid.endsWith('-HW') ? 'meraki' : (sourceOf.get(manufacturer) ?? ''),
            },
        )
        keepCategory(pid, category)
        return id
    }
    const c9300 = model('C9300-48P-E', 'Catalyst 9300 48-port PoE+', cisco, 'switch', 715)
    model('C9300-NM-8X', 'Catalyst 9300 8x10G network module', cisco, 'module')
    model('PWR-C1-715WAC', 'Catalyst 9300 715W AC power supply', cisco, 'psu')
    const isr4331 = model('ISR4331/K9', 'ISR 4331 router', cisco, 'router', 250)
    const mr46 = model('MR46-HW', 'Meraki MR46 access point', cisco, 'ap', 30)
    model('MX85-HW', 'Meraki MX85 security appliance', cisco, 'firewall', 60)
    const aruba6300 = model('JL659A', 'Aruba 6300M 48G PoE switch', hpe, 'switch', 880)
    const ap535 = model('JZ336A', 'Aruba AP-535 access point', hpe, 'ap', 28)
    const fg60f = model('FG-60F', 'FortiGate 60F', fortinet, 'firewall', 20)
    const cp3600 = model('CPAP-SG3600', 'Check Point Quantum 3600', checkpoint, 'firewall', 75)
    model('SFP-10G-SR', '10GBASE-SR SFP+ module', cisco, 'optic')
    model('QSFP-100G-SR4-S', '100GBASE-SR4 QSFP module', cisco, 'optic')
    ensure('cmdb_hardware_product_model', { name: 'C9300-48P', manufacturer: cisco }) // as Discovery would create it

    const lifecycle = (modelId: string, endOfSale: string, endOfSupport: string) => {
        const written = writeModelLifecycle(modelId, { endOfSale, endOfSupport }, { source: 'manual', reference: 'Demo data: illustrative dates' })
        for (const why of written.refused) log.warn(`Demo model lifecycle not saved: ${why}`)
    }
    lifecycle(c9300, '2028-10-31', '2033-10-31')
    lifecycle(isr4331, '2023-11-07', '2028-11-30')
    lifecycle(mr46, '2026-06-30', '2031-06-30')
    lifecycle(fg60f, '2027-03-31', '2032-03-31')

    const aliases: Array<[string, string]> = [
        ['Cisco Systems, Inc.', cisco], ['Cisco', cisco], ['Cisco Meraki', cisco],
        ['Hewlett Packard Enterprise', hpe], ['Aruba Networks', hpe], ['HPE', hpe],
        ['Fortinet, Inc.', fortinet], ['Fortinet', fortinet],
        ['Check Point Software Technologies Ltd.', checkpoint], ['Check Point', checkpoint],
    ]
    for (const [alias, manufacturer] of aliases) ensure('x_daas_ham_manufacturer_alias', { alias }, { manufacturer })
    ensure('x_daas_ham_model_match_rule', { pattern: 'C9300-48P' }, { order: 100, manufacturer: cisco, match_type: 'prefix', model: c9300, active: true })
    ensure('x_daas_ham_model_match_rule', { pattern: '^FortiGate[- ]?60F' }, { order: 100, manufacturer: fortinet, match_type: 'regex', model: fg60f, active: true })

    const template = (name: string, description: string, items: Array<[string, number]>, customerId = '') => {
        const id = ensure('x_daas_ham_site_template', { name }, { description, active: true, customer: customerId })
        for (const [modelId, quantity] of items) ensure('x_daas_ham_site_template_item', { site_template: id, model: modelId }, { quantity, optional: false })
        return id
    }
    const smallBranch = template('Small branch', '1 firewall, 2 access switches, 4 access points', [[fg60f, 1], [c9300, 2], [mr46, 4]])
    const campusFloor = template('Campus floor (Aruba)', '2 Aruba 6300M switches, 12 AP-535', [[aruba6300, 2], [ap535, 12]], globex)

    const agreement = (customerId: string, description: string, terms: Fields) =>
        ensure('x_daas_ham_agreement', { customer: customerId }, { short_description: description, state: 'active', account_manager: ADMIN_USER, ...terms })
    const acmeAgreement = agreement(acme, 'Acme Retail managed network', {
        currency: 'EUR', starts: '2026-01-01', ends: '2030-12-31', replacement_tier: 'same_day', refresh_cycle_months: 60, refresh_basis: 'earliest',
        spare_pool_ratio: 0.05, overdue_return_days: 30, lost_asset_fee: 1500, late_return_fee: 150, damage_fee: 400, attestation_interval_months: 12,
    })
    const globexAgreement = agreement(globex, 'Globex data-centre and campus network', {
        currency: 'EUR', starts: '2026-03-01', ends: '2029-02-28', replacement_tier: 'four_hour', refresh_cycle_months: 48, refresh_basis: 'cycle',
        spare_pool_ratio: 0.1, overdue_return_days: 21, lost_asset_fee: 2500, late_return_fee: 250, damage_fee: 600, attestation_interval_months: 6,
    })
    keepCurrency(acmeAgreement)
    keepCurrency(globexAgreement)
    const quantities: Array<[string, string, number]> = [
        [acmeAgreement, 'switch', 200], [acmeAgreement, 'ap', 600], [acmeAgreement, 'firewall', 60],
        [globexAgreement, 'switch', 40], [globexAgreement, 'ap', 120], [globexAgreement, 'firewall', 8],
    ]
    for (const [agreementId, deviceClass, contracted] of quantities) {
        ensure('x_daas_ham_agreement_quantity', { agreement: agreementId, device_class: deviceClass }, { contracted_quantity: contracted })
    }

    // A Subscription line bills in its Agreement's currency (EUR here).
    const line = (description: string, fields: Fields) => ensure('x_daas_ham_subscription_line', { description }, fields)
    const acmeHqPackage = line('Acme HQ site package', { agreement: acmeAgreement, customer: acme, line_type: 'site_package', site: acmeHq, monthly_rate: 4500, status: 'active', start_date: '2026-02-01' })
    line('Acme managed switches', { agreement: acmeAgreement, customer: acme, line_type: 'device_class', device_class: 'switch', monthly_rate: 45, status: 'pending' })
    line('Acme managed Wi-Fi', { agreement: acmeAgreement, customer: acme, line_type: 'device_class', device_class: 'ap', monthly_rate: 18, status: 'pending' })
    line('Acme managed firewalls', { agreement: acmeAgreement, customer: acme, line_type: 'device_class', device_class: 'firewall', monthly_rate: 60, status: 'pending' })
    line('Globex managed switching', { agreement: globexAgreement, customer: globex, line_type: 'device_class', device_class: 'switch', monthly_rate: 70, status: 'pending' })

    const entries: Array<[string, CatalogEntryType, string, number]> = [
        [acme, 'model', c9300, 45], [acme, 'model', mr46, 18], [acme, 'model', fg60f, 60], [acme, 'site_template', smallBranch, 420],
        [globex, 'model', aruba6300, 70], [globex, 'model', ap535, 16], [globex, 'model', cp3600, 140], [globex, 'site_template', campusFloor, 520],
    ]
    for (const [customerId, kind, ref, rate] of entries) {
        ensure('x_daas_ham_catalog_entry', { customer: customerId, entry_type: kind, [kind]: ref }, { monthly_rate: rate, active: true })
    }

    const checklist = (name: string, source: string, steps: string[], extra: Fields = {}) => {
        const id = ensure('x_daas_ham_staging_template', { name }, { staging_source: source, active: true, ...extra })
        steps.forEach((label, i) => ensure('x_daas_ham_staging_tmpl_item', { template: id, label }, { order: (i + 1) * 100, mandatory: true }))
    }
    checklist('Generic in-house staging', 'in_house', [
        'Upgrade to golden firmware', 'Apply base configuration template', 'Assign OEM licence / subscription',
        'Claim into controller / management platform', 'Burn-in test (4 hours)', 'Attach provider tag label',
    ])
    checklist('Distributor pre-staged: verify', 'distributor', [
        'Serial and PID match the ASN', 'Configuration applied by distributor verified', 'Attach provider tag label',
    ])
    checklist('Acme Meraki claim', 'in_house', ['Claim into Acme Meraki organisation', 'Bind to Acme store network template', 'Attach provider tag label'], {
        customer: acme, manufacturer: cisco, device_class: 'ap',
    })

    const user = (table: string, userName: string, first: string, last: string, roleName: string, company = '') => {
        const id = ensure(table, { user_name: userName }, { first_name: first, last_name: last, email: `${userName}@example.com`, active: true, company })
        const role = new GlideRecord('sys_user_role')
        if (role.get('name', roleName)) ensure('sys_user_has_role', { user: id, role: role.getUniqueValue() })
        return id
    }
    const inventoryUser = user('sys_user', 'naas.inventory', 'Ingrid', 'Depot (demo)', ROLE.inventoryTech)
    user('sys_user', 'naas.field', 'Femi', 'Field (demo)', ROLE.fieldTech)
    user('customer_contact', 'acme.admin', 'Ada', 'Acme (demo)', ROLE.customerAdmin, acme)
    const acmeContact = user('customer_contact', 'acme.hq.contact', 'Sam', 'Site (demo)', ROLE.siteContact, acme)
    // The demo inventory tech works at the depot and the staging centre: a member of their Assignment group (ADR 0018).
    const depotGroup = new GlideRecord('sys_user_group')
    if (depotGroup.get('name', DEMO_DEPOT_GROUP)) {
        const groupId = depotGroup.getUniqueValue()
        ensure('sys_user_grmember', { user: inventoryUser, group: groupId })
        for (const stockroomId of [depot, stagingCentre]) {
            const assigned = new GlideRecord('alm_stockroom')
            if (!assigned.get(stockroomId) || str(assigned, 'assignment_group') === groupId) continue
            assigned.setValue('assignment_group', groupId)
            if (!assigned.update()) log.warn(`Demo stockroom ${str(assigned, 'name')} not assigned to its group: ${refusal(assigned)}`)
        }
    } else {
        log.warn(`Demo group "${DEMO_DEPOT_GROUP}" not found: the demo inventory tech is assigned to no stockroom`)
    }
    const hq = new GlideRecord('cmn_location')
    if (hq.get(acmeHq)) {
        hq.setValue('x_daas_ham_site_contacts', acmeContact)
        save(hq, 'site Acme HQ Amsterdam (its site contact)')
    }

    // Every demo network asset is a fleet asset (ADR 0016): newAsset makes it one, the Provider owning it.
    const stock = (modelId: string, count: number, prefix: string, stage: Stage, fields: Fields) => {
        for (let i = 0; i < count; i++) {
            const serial = `${prefix}${String(i).padStart(4, '0')}`
            const existing = new GlideRecord('alm_hardware')
            if (existing.get('serial_number', serial)) continue
            const asset = newAsset(modelId, stage)
            asset.setValue('serial_number', serial)
            asset.setValue('asset_tag', `NAAS-D${serial.slice(-7)}`)
            asset.setValue('x_daas_ham_staging_source', 'in_house')
            for (const [field, value] of Object.entries(fields)) asset.setValue(field, value)
            if (!asset.insert()) log.warn(`Demo asset ${serial} not created: ${refusal(asset)}`)
        }
    }
    stock(c9300, 6, 'DEMOC93', 'available', { stockroom: depot, company: provider })
    stock(mr46, 10, 'DEMOMR46', 'available', { stockroom: depot, company: provider })
    stock(fg60f, 4, 'DEMOFG60F', 'available', { stockroom: depot, company: provider })
    stock(aruba6300, 4, 'DEMOJL659', 'available', { stockroom: depot, company: provider, x_daas_ham_staging_source: 'distributor' })
    stock(c9300, 2, 'DEMOSPARE', 'spare_pool', { stockroom: depot, company: acme, x_daas_ham_agreement: acmeAgreement })
    stock(mr46, 1, 'DEMOHOTSPARE', 'spare_pool', { stockroom: acmeSpares, company: acme, x_daas_ham_agreement: acmeAgreement })
    stock(c9300, 2, 'DEMOLIVE', 'in_service', {
        company: acme, x_daas_ham_agreement: acmeAgreement, x_daas_ham_site: acmeHq, location: acmeMdf, x_daas_ham_rack: acmeRack,
        x_daas_ham_rack_face: 'front', x_daas_ham_subscription_line: acmeHqPackage, x_daas_ham_in_service_date: '2026-02-01 09:00:00',
        x_daas_ham_install_completed: '2026-02-01 08:00:00', x_daas_ham_last_seen: '2026-11-06 23:00:00', x_daas_ham_seen_source: 'nms',
    })
    const eachLive = (what: string, change: (asset: GlideRecord) => void) => {
        const live = new GlideRecord('alm_hardware')
        live.addQuery('serial_number', 'STARTSWITH', 'DEMOLIVE')
        live.addEncodedQuery(fleetCondition())
        live.orderBy('serial_number')
        live.query()
        while (live.next()) {
            change(live)
            save(live, `asset ${str(live, 'serial_number')} (${what})`)
        }
    }
    let ru = 40
    eachLive('its rack unit', (live) => {
        live.setValue('x_daas_ham_ru_start', ru)
        ru -= 2
    })
    // OEM coverage for the in-service demo switches (normally from the Cisco API or CSV import)
    eachLive('its coverage', (covered) => {
        ensure('x_daas_ham_oem_coverage', { serial_number: str(covered, 'serial_number'), contract_number: 'DEMO-SNTC-1' }, {
            asset: covered.getUniqueValue(),
            vendor: 'cisco',
            service_level: 'SNTC 8X5XNBD',
            covered: true,
            start_date: '2026-02-01',
            end_date: '2029-01-31',
            source: 'manual',
        })
        covered.setValue('x_daas_ham_coverage_end', '2029-01-31')
        covered.setValue('x_daas_ham_coverage_level', 'SNTC 8X5XNBD')
    })
    // A lease ending before the Acme agreement it serves: the daily review flags it and raises a decision
    const lessor = ensure('core_company', { name: 'Demo Capital Leasing' }, { vendor: true })
    const lease = ensure('x_daas_ham_lease_schedule', { vendor_contract: 'DEMO-LS-001' }, {
        vendor: lessor,
        short_description: 'Demo lease of the Acme HQ core switches',
        starts: '2024-02-01',
        ends: '2027-01-31',
        monthly_payment: 180,
        buyout_price: 1200,
        decision_lead_days: 120,
        state: 'active',
    })
    // Billing history of the in-service switches (normally opened by in-service detection), and their lease
    eachLive('its lease', (leased) => {
        ensure('x_daas_ham_service_interval', { asset: leased.getUniqueValue() }, {
            subscription_line: acmeHqPackage,
            customer: acme,
            site: acmeHq,
            start_date: '2026-02-01',
        })
        leased.setValue('x_daas_ham_lease', lease)
    })
    log.info('demo data loaded')
}
