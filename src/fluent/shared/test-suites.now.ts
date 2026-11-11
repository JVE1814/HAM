import '@servicenow/sdk/global'
import { TestSuite } from '@servicenow/sdk/core'
import {
    customerAdminVisibilityTest,
    inventoryTechAuditScanTest,
    inventoryTechAuditVisibilityTest,
    inventoryTechVisibilityTest,
} from './visibility-tests.now'
import { addToFleetTest } from '../fleet/tests.now'
import { lifecycleImportTest } from '../models/tests.now'
import {
    cancelRefusedOnceShippedTest,
    lostInTransitResourcingTest,
    offCatalogOrderTest,
    sparePoolTopUpTest,
    transferStageTest,
    withinAgreementOrderTest,
} from '../orders/tests.now'
import { warehouseScanRulesTest } from '../warehouse/tests.now'
import { customerReturnRequestTest, returnEvaluationTest } from '../returns/tests.now'
import { replacementWithinAgreementTest } from '../break-fix/tests.now'
import { trackingWebhookTest } from '../delivery/tests.now'
import { leasedAssetOwnershipTest, leaseExtensionTest } from '../leases/tests.now'
import { closedBillingPeriodLockedTest } from '../billing/tests.now'
import { rackPowerBudgetTest } from '../racks/tests.now'

/* The ATF suites, one per delivery phase: each lists tests of several features. */

export const phase1Suite = TestSuite({
    $id: Now.ID['atf_suite_p1'],
    name: 'NaaS - P1',
    tests: [
        customerAdminVisibilityTest,
        inventoryTechVisibilityTest,
        inventoryTechAuditVisibilityTest,
        withinAgreementOrderTest,
        offCatalogOrderTest,
        transferStageTest,
        addToFleetTest,
        lifecycleImportTest,
        warehouseScanRulesTest,
        inventoryTechAuditScanTest,
        cancelRefusedOnceShippedTest,
        sparePoolTopUpTest,
    ],
})

export const phase2Suite = TestSuite({
    $id: Now.ID['atf_suite_p2'],
    name: 'NaaS - P2',
    tests: [replacementWithinAgreementTest, returnEvaluationTest, customerReturnRequestTest, lostInTransitResourcingTest],
})

export const phase3Suite = TestSuite({
    $id: Now.ID['atf_suite_p3'],
    name: 'NaaS - P3',
    tests: [leasedAssetOwnershipTest, leaseExtensionTest, closedBillingPeriodLockedTest, rackPowerBudgetTest, trackingWebhookTest],
})
