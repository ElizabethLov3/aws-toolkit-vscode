/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../../shared/extensionGlobals'
import { customLearnMoreUri, newCustomizationMessage } from '../models/constants'
import { localize, openUrl } from '../../shared/utilities/vsCodeUtils'
import { AuthUtil } from './authUtil'
import * as vscode from 'vscode'
import { createCommonButtons } from '../../shared/ui/buttons'
import { DataQuickPickItem, showQuickPick } from '../../shared/ui/pickerPrompter'
import CodeWhispererUserClient, { Customization, ResourceArn } from '../client/codewhispereruserclient'
import { codicon, getIcon } from '../../shared/icons'
import { getLogger } from '../../shared/logger/logger'
import { showMessageWithUrl } from '../../shared/utilities/messages'
import { parse } from '@aws-sdk/util-arn-parser'
import { Commands } from '../../shared/vscode/commands2'
import { RegionProfile, vsCodeState } from '../models/model'
import { pageableToCollection } from '../../shared/utilities/collectionUtils'
import { isAwsError } from '../../shared/errors'
import { ProfileChangedEvent } from '../region/regionProfileManager'

export class CustomizationProvider {
    readonly region: string
    constructor(
        private readonly client: CodeWhispererUserClient,
        private readonly profile: RegionProfile
    ) {
        this.region = profile.region
    }

    async listAvailableCustomizations(): Promise<Customization[]> {
        const requester = async (request: CodeWhispererUserClient.ListAvailableCustomizationsRequest) =>
            this.client.listAvailableCustomizations(request).promise()

        try {
            const request = { profileArn: this.profile.arn }
            const customizations = await pageableToCollection(requester, request, 'nextToken', 'customizations')
                .flatten()
                .promise()

            return customizations
        } catch (e) {
            const logMsg = isAwsError(e) ? `requestId=${e.requestId}; message=${e.message}` : (e as Error).message
            getLogger().error(`failed to listAvailableCustomizations: ${logMsg}`)
            return []
        }
    }

    static async init(profile: RegionProfile): Promise<CustomizationProvider> {
        const client = await AuthUtil.instance.regionProfileManager.createQClient(profile)
        return new CustomizationProvider(client, profile)
    }
}

export const onProfileChangedListener: (event: ProfileChangedEvent) => any = async (event) => {
    // Skip because customization means the following validation has been done
    if (event.intent === 'customization') {
        return
    }
    const logger = getLogger()
    if (!event.profile) {
        await setSelectedCustomization(baseCustomization)
        return
    }

    // Validate user still has access to the selected customization.
    const selectedCustomization = getSelectedCustomization()
    // No need to validate base customization which has empty arn.
    if (selectedCustomization.arn.length > 0) {
        const customizationProvider = await CustomizationProvider.init(event.profile)
        const customizations = await customizationProvider.listAvailableCustomizations()

        const r = customizations.find((it) => it.arn === selectedCustomization.arn)
        if (!r) {
            logger.debug(
                `profile ${event.profile.name} doesnt have access to customization ${selectedCustomization.name} but has access to ${customizations.map((it) => it.name)}`
            )
            await switchToBaseCustomizationAndNotify()
        }
    }
}

/**
 *
 * @param availableCustomizations
 * @returns customization diff of availableCustomizations vs. persisted customizations
 */
export const getNewCustomizations = (availableCustomizations: Customization[]) => {
    const persistedCustomizations = getPersistedCustomizations()
    return availableCustomizations.filter((c) => !persistedCustomizations.map((p) => p.arn).includes(c.arn))
}

export async function notifyNewCustomizations() {
    let availableCustomizations: Customization[] = []
    try {
        availableCustomizations = await getAvailableCustomizationsList()
        AuthUtil.instance.isCustomizationFeatureEnabled = true
    } catch (error) {
        // On receiving any error, we will disable the customization feature
        AuthUtil.instance.isCustomizationFeatureEnabled = false
        await setSelectedCustomization(baseCustomization)
        getLogger().error(`Failed to fetch customizations: %O`, error)
        return
    }

    const selectedCustomization = getSelectedCustomization()
    if (!isSelectedCustomizationAvailable(availableCustomizations, selectedCustomization)) {
        await switchToBaseCustomizationAndNotify()
    }

    const newCustomizations = getNewCustomizations(availableCustomizations)
    await setPersistedCustomizations(availableCustomizations)

    if (newCustomizations.length === 0) {
        return
    }

    await setNewCustomizationsAvailable(newCustomizations.length)

    const select = localize(
        'AWS.codewhisperer.customization.notification.new_customizations.select',
        'Select Customization'
    )
    const learnMore = localize(
        'AWS.codewhisperer.customization.notification.new_customizations.learn_more',
        'Learn More'
    )
    void vscode.window.showInformationMessage(newCustomizationMessage, select, learnMore).then(async (resp) => {
        if (resp === select) {
            showCustomizationPrompt().catch((e) => {
                getLogger().error('showCustomizationPrompt failed: %s', (e as Error).message)
            })
        } else if (resp === learnMore) {
            // TODO: figure out the right uri
            void openUrl(vscode.Uri.parse(customLearnMoreUri))
        }
    })
}

// Return true when either it's the default option or the selected one is in the ones we fetched from upstream.
export const isSelectedCustomizationAvailable = (available: Customization[], selected: Customization) => {
    return selected.arn === '' || available.map((c) => c.arn).includes(selected.arn)
}

export const baseCustomization = {
    arn: '',
    name: localize('AWS.codewhisperer.customization.base.label', 'Amazon Q foundation (Default)'),
    description: localize(
        'AWS.codewhisperer.customization.base.detail',
        'Receive suggestions from Amazon Q base model'
    ),
}

/**
 * @returns customization selected by users, `baseCustomization` if none is selected
 */
export const getSelectedCustomization = (): Customization => {
    if (
        !AuthUtil.instance.isCustomizationFeatureEnabled ||
        !AuthUtil.instance.isValidEnterpriseSsoInUse() ||
        !AuthUtil.instance.conn
    ) {
        return baseCustomization
    }

    const selectedCustomizationArr = globals.globalState.tryGet<{ [label: string]: Customization }>(
        'CODEWHISPERER_SELECTED_CUSTOMIZATION',
        Object,
        {}
    )
    const selectedCustomization = selectedCustomizationArr[AuthUtil.instance.conn.label]

    if (selectedCustomization && selectedCustomization.name !== '') {
        return selectedCustomization
    } else {
        return baseCustomization
    }
}

/**
 * @param customization customization to select
 * @param isOverride if the API call is made from us (Q) but not users' intent, set isOverride to TRUE
 * Override happens when ALL following conditions are met
 *  1. service returns non-empty override customization arn, refer to [featureConfig.ts]
 *  2. the override customization arn is different from the previous override customization if any. The purpose is to only do override once on users' behalf.
 */
export const setSelectedCustomization = async (customization: Customization, isOverride: boolean = false) => {
    if (!AuthUtil.instance.isValidEnterpriseSsoInUse() || !AuthUtil.instance.conn) {
        return
    }
    if (isOverride) {
        const previousOverride = globals.globalState.tryGet<string>('aws.amazonq.customization.overrideV2', String)
        if (customization.arn === previousOverride) {
            return
        }
    }
    const selectedCustomizationObj = globals.globalState.tryGet<{ [label: string]: Customization }>(
        'CODEWHISPERER_SELECTED_CUSTOMIZATION',
        Object,
        {}
    )
    selectedCustomizationObj[AuthUtil.instance.conn.label] = customization
    getLogger().debug(`Selected customization ${customization.name} for ${AuthUtil.instance.conn.label}`)

    await globals.globalState.update('CODEWHISPERER_SELECTED_CUSTOMIZATION', selectedCustomizationObj)
    if (isOverride) {
        await globals.globalState.update('aws.amazonq.customization.overrideV2', customization.arn)
    }
    vsCodeState.isFreeTierLimitReached = false
    await Commands.tryExecute('aws.amazonq.refreshStatusBar')
}

export const getPersistedCustomizations = (): Customization[] => {
    if (!AuthUtil.instance.isValidEnterpriseSsoInUse() || !AuthUtil.instance.conn) {
        return []
    }
    const persistedCustomizationsObj = globals.globalState.tryGet<{ [label: string]: Customization[] }>(
        'CODEWHISPERER_PERSISTED_CUSTOMIZATIONS',
        Object,
        {}
    )
    return persistedCustomizationsObj[AuthUtil.instance.conn.label] || []
}

export const setPersistedCustomizations = async (customizations: Customization[]) => {
    if (!AuthUtil.instance.isValidEnterpriseSsoInUse() || !AuthUtil.instance.conn) {
        return
    }
    const persistedCustomizationsObj = globals.globalState.tryGet<{ [label: string]: Customization[] }>(
        'CODEWHISPERER_PERSISTED_CUSTOMIZATIONS',
        Object,
        {}
    )
    persistedCustomizationsObj[AuthUtil.instance.conn.label] = customizations
    await globals.globalState.update('CODEWHISPERER_PERSISTED_CUSTOMIZATIONS', persistedCustomizationsObj)
}

export const getNewCustomizationsAvailable = () => {
    return globals.globalState.tryGet('aws.amazonq.codewhisperer.newCustomizations', Number, 0)
}

export const setNewCustomizationsAvailable = async (num: number) => {
    await globals.globalState.update('aws.amazonq.codewhisperer.newCustomizations', num)
    vsCodeState.isFreeTierLimitReached = false
}

export async function showCustomizationPrompt() {
    await setNewCustomizationsAvailable(0)
    await showQuickPick(createCustomizationItems(), {
        title: localize('AWS.codewhisperer.customization.quickPick.title', 'Select a Customization'),
        placeholder: localize(
            'AWS.codewhisperer.customization.quickPick.placeholder',
            'You have access to the following customizations'
        ),
        buttons: createCommonButtons() as vscode.QuickInputButton[],
        compare: (a, b) => {
            if (a.invalidSelection) {
                return -1
            }
            if (b.invalidSelection) {
                return 1
            }
            return a.label < b.label ? -1 : 1
        },
        recentlyUsed: localize('AWS.codewhisperer.customization.selected', '   Connected'),
    })
}

const createCustomizationItems = async () => {
    const items = []
    const availableCustomizations = await getAvailableCustomizationsList()

    // Order matters
    // 1. read the old snapshot of customizations
    const persistedCustomizations = getPersistedCustomizations()

    // 2. update the customizations snapshot with the latest
    await setPersistedCustomizations(availableCustomizations)

    const selectedCustomization = getSelectedCustomization()
    if (!isSelectedCustomizationAvailable(availableCustomizations, selectedCustomization)) {
        await switchToBaseCustomizationAndNotify()
    }

    if (availableCustomizations.length === 0) {
        items.push(createBaseCustomizationItem())

        void showMessageWithUrl(
            localize(
                'AWS.codewhisperer.customization.noCustomizations.description',
                'You dont have access to any Amazon Q customization. Contact your admin for access.'
            ),
            customLearnMoreUri,
            localize('AWS.codewhisperer.customization.notification.new_customizations.learn_more', 'Learn More'),
            'info'
        )
        return items
    }

    const persistedArns = persistedCustomizations.map((c) => c.arn)
    const customizationNameToCount = availableCustomizations.reduce((map, customization) => {
        if (customization.name) {
            map.set(customization.name, (map.get(customization.name) || 0) + 1)
        }

        return map
    }, new Map<string, number>())

    items.push(createBaseCustomizationItem())
    items.push(
        ...availableCustomizations.map((c) => {
            let shouldPrefixAccountId = false
            if (c.name) {
                const cnt = customizationNameToCount.get(c.name) || 0
                if (cnt > 1) {
                    shouldPrefixAccountId = true
                }
            }

            return createCustomizationItem(c, persistedArns, shouldPrefixAccountId)
        })
    )
    return items
}

const createBaseCustomizationItem = () => {
    const label = codicon`${getIcon('vscode-circuit-board')} ${localize(
        'AWS.codewhisperer.customization.base.label',
        'Amazon Q foundation (Default)'
    )}`
    const selectedArn = getSelectedCustomization().arn
    return {
        label: label,
        onClick: async () => {
            await selectCustomization(baseCustomization)
        },
        detail: localize(
            'AWS.codewhisperer.customization.base.description',
            'Receive suggestions from Amazon Q base model'
        ),
        description: renderDescriptionText(label),
        recentlyUsed: selectedArn === baseCustomization.arn,
    } as DataQuickPickItem<string>
}

/**
 * When users click "select customizations", we're showing ALL customizations across different profiles.
 * Thus If users select the customization, we also change the profile if the customization is accessible from a different profile.
 */
const createCustomizationItem = (
    customization: Customization & { profile: RegionProfile },
    persistedArns: (ResourceArn | undefined)[],
    shouldPrefixAccountId: boolean
) => {
    const accountId = parse(customization.arn).accountId
    const displayedName = customization.name
        ? shouldPrefixAccountId
            ? accountId
                ? `${customization.name} (${accountId})`
                : `${customization.name} (${customization.profile.name})`
            : `${customization.name} (${customization.profile.name})`
        : 'unknown'

    const isNewCustomization = !persistedArns.includes(customization.arn)
    const label = codicon`${getIcon('vscode-circuit-board')} ${displayedName}`
    const selectedArn = getSelectedCustomization().arn
    return {
        label: label,
        onClick: async () => {
            const profile = AuthUtil.instance.regionProfileManager.activeRegionProfile
            if (profile && customization.profile.arn !== profile.arn) {
                await AuthUtil.instance.regionProfileManager.switchRegionProfile(customization.profile, 'customization')
            }
            await selectCustomization(customization)
        },
        detail:
            customization.description !== ''
                ? customization.description
                : localize('AWS.codewhisperer.customization.no.description.text', 'No description provided'),
        description: renderDescriptionText(label, isNewCustomization),
        data: customization.arn,
        recentlyUsed: selectedArn === customization.arn,
    } as DataQuickPickItem<string>
}

export const selectCustomization = async (customization: Customization) => {
    // If the newly selected customization is same as the old one, do nothing
    const selectedCustomization = getSelectedCustomization()
    if (selectedCustomization.arn === customization.arn) {
        return
    }
    await setSelectedCustomization(customization)
    const suffix =
        customization.arn === baseCustomization.arn ? customization.name : `${customization.name} customization.`
    void vscode.window.showInformationMessage(
        localize(
            'AWS.codewhisperer.customization.selected.message',
            'Amazon Q suggestions are now coming from the {0}',
            suffix
        )
    )
}

// Return all customizations across different profiles and associate the customization with the source profile
export const getAvailableCustomizationsList = async () => {
    const items: (Customization & { profile: RegionProfile })[] = []
    const profiles: RegionProfile[] = []
    try {
        const r = await AuthUtil.instance.regionProfileManager.listRegionProfile()
        profiles.push(...r)
    } catch (e) {
        getLogger().error(`Failed to list customizations because listAvailableProfiles failed %s`, (e as Error).message)
        return []
    }

    for (const profile of profiles) {
        const provider = await CustomizationProvider.init(profile)
        const customizations = await provider.listAvailableCustomizations()

        for (const c of customizations) {
            items.push({
                ...c,
                profile: profile,
            })
        }
    }

    return items
}

// show notification that selected customization is not available, switching back to base
export const switchToBaseCustomizationAndNotify = async () => {
    await setSelectedCustomization(baseCustomization)
    const selectCustomizationLabel = localize(
        'AWS.codewhisperer.customization.notification.selectCustomization',
        'Select Another Customization'
    )
    const selection = await vscode.window.showWarningMessage(
        localize(
            'AWS.codewhisperer.customization.notification.selected_customization_not_available',
            'Selected Amazon Q customization is not available. Contact your administrator. Your instance of Amazon Q is using the foundation model.'
        ),
        selectCustomizationLabel
    )
    if (selection === selectCustomizationLabel) {
        await showCustomizationPrompt()
    }
}

const renderDescriptionText = (label: string, isNewCustomization: boolean = false) => {
    return isNewCustomization ? '   New' : ''
}
