import ValidationError from '../errors/ValidationError';
import Log, { LogUtils } from './Log';
import { Role, Message, MessageOptions, TextChannel, AwaitMessagesOptions, DMChannel, GuildMember, MessageActionRow, MessageButton } from 'discord.js';
import DiscordUtils from '../utils/DiscordUtils';
import { URL } from 'url';
import { BountyCollection } from '../types/bounty/BountyCollection';
import { Applicant, Bounty } from '../types/bounty/Bounty';
import { BountyStatus } from '../constants/bountyStatus';
import { PaidStatus } from '../constants/paidStatus';
import { CreateRequest } from '../requests/CreateRequest';
import mongo, { Db, UpdateWriteOpResult } from 'mongodb';
import MongoDbUtils from '../utils/MongoDbUtils';
import { Activities } from '../constants/activities';
import { CustomerCollection } from '../types/bounty/CustomerCollection';
import { UpsertUserWalletRequest } from '../requests/UpsertUserWalletRequest';
import { handler } from '../activity/bounty/Handler';
import { UserCollection } from '../types/user/UserCollection';


const BountyUtils = {
    TWENTYFOUR_HOURS_IN_SECONDS: 24 * 60 * 60,

    validateDescription(description: string): void {
        const CREATE_SUMMARY_REGEX = /^[\w\s\W]{1,4000}$/;
        if (description == null || !CREATE_SUMMARY_REGEX.test(description)) {
            throw new ValidationError(
                'Please enter a valid summary: \n' +
                '- 4000 characters maximum\n ' +
                '- alphanumeric\n ' +
                '- special characters: .!@#$%&,?');
        }
    },

    validateCriteria(criteria: string): void {
        const CREATE_CRITERIA_REGEX = /^[\w\s\W]{1,1000}$/;
        if (criteria == null || !CREATE_CRITERIA_REGEX.test(criteria)) {
            throw new ValidationError(
                'Please enter a valid criteria: \n' +
                '- 1000 characters maximum\n ' +
                '- alphanumeric\n ' +
                '- special characters: .!@#$%&,?'
            );
        }
    },

    validateDate(date: string): Date {
        try {
            return new Date(date + 'T00:00:00.000Z');
        } catch (e) {
            LogUtils.logError('failed to validate date', e);
            throw new ValidationError('Please try `UTC` date in format yyyy-mm-dd, i.e 2021-08-15');
        }
    },

    validateTitle(title: string): void {
        const CREATE_TITLE_REGEX = /^[\w\s\W]{1,80}$/;
        if (title == null || !CREATE_TITLE_REGEX.test(title)) {
            throw new ValidationError(
                'Please enter a valid title: \n' +
                '- 80 characters maximum\n ' +
                '- alphanumeric\n ' +
                '- special characters: .!@#$%&,?',
            );
        }
    },

    validateTag(tag: string): void {
        const CREATE_TAG_REGEX = /^[\w\s\W]{1,80}$/;
        if (tag == null || !CREATE_TAG_REGEX.test(tag)) {
            throw new ValidationError(
                'Please enter a valid tag: \n' +
                '- 80 characters maximum\n ' +
                '- alphanumeric\n ' +
                '- special characters: .!@#$%&,?:|-_',
            );
        }
    },

    validateReward(rewardInput: string): void {
        const [stringAmount, symbol] = (rewardInput != null) ? rewardInput.split(' ') : [null, null];
        const ALLOWED_CURRENCIES = ['BANK', 'ETH', 'BTC', 'USDC', 'USDT', 'TempCity', 'gOHM', 'LUSD', 'FOX', 'oneFOX', 'POINTS'];
        const isValidCurrency = (typeof symbol !== 'undefined') && (ALLOWED_CURRENCIES.find(element => {
            return element.toLowerCase() === symbol.toLowerCase();
        }) !== undefined);
        const MAXIMUM_REWARD = 100000000.00;

        if (!isValidCurrency) {
            throw new ValidationError(
                '- Specify a valid currency. The accepted currencies are:\n' +
                `${ALLOWED_CURRENCIES.toString()}\n` +
                'Please reach out to your favorite Bounty Board representative to expand this list!',
            );
        }

        const amount: number = Number(stringAmount);
        if (Number.isNaN(amount) || !Number.isFinite(amount) || amount < 0 || amount > MAXIMUM_REWARD) {
            throw new ValidationError(
                'Please enter a valid decimal reward value: \n ' +
                '- 0 minimum, 100 million maximum \n ' +
                'Please reach out to your favorite Bounty Board representative to expand this range!',
            );
        }
    },

    validateEvergreen(evergreen: boolean, claimLimit: number, assign: boolean) {
        if (evergreen && assign) {
            throw new ValidationError('Cannot use for-user with multiple-claimant bounties');
        }
        if (claimLimit !== undefined && (claimLimit < 0 || claimLimit > 100)) {
            throw new ValidationError('claimants should be from 0 (meaning infinite) to 100');
        }
    },

    validateRequireApplications(request: CreateRequest) {
        if (request.evergreen && request.requireApplication) {
            throw new ValidationError('Cannot require applications on multi-claimant bounties.');
        }

        if (request.requireApplication && request.assign) {
            throw new ValidationError('Cannot require applications on bounties assigned to a user.');
        }
    },

    async validateGate(gate: string, guildId: string): Promise<void> {
        try {
            await DiscordUtils.getRoleFromRoleId(gate, guildId);
        }
        catch (e) {
            Log.info(`${gate} is not a valid role on this server`);
            throw new ValidationError('Please choose a valid role on this server.');
        }
    },

    async validateAssign(assign: string, guildId: string, applicants: Applicant[]): Promise<void> {
        if (applicants && !applicants.some(applicant => applicant.discordId == assign)) {
            let applicantList: string = '';
            applicants.forEach(applicant => { applicantList += `\n ${applicant.discordHandle}` });
            throw new ValidationError(`Please choose a user from the list of applicants: ${applicantList}`);
        }
        try {
            await DiscordUtils.getGuildMemberFromUserId(assign, guildId);
        }
        catch (e) {
            Log.info(`User ${assign} is not a user or was unable to be fetched`);
            throw new ValidationError('Please choose a valid user on this server.');
        }
    },

    threeMonthsFromNow(): Date {
        let ts: number = Date.now();
        const date: Date = new Date(ts);
        return new Date(date.setMonth(date.getMonth() + 3));
    },

    formatDisplayDate(dateIso: string): string {
        const options: Intl.DateTimeFormatOptions = {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        };
        return (new Date(dateIso)).toLocaleString('en-US', options);
    },

    validateBountyId(bountyId: string): void {
        Log.debug(`validating bountyId: ${bountyId}`);
        const BOUNTY_ID_REGEX = /^[a-f\d]{24}$/i;
        if ((bountyId == null || !BOUNTY_ID_REGEX.test(bountyId))) {
            throw new ValidationError(
                `Thank you for giving bounty board a try!\n` +
                `Please enter a valid bounty ID, which can be found on the website or in the bounties channel \n` +
                ` - ${process.env.BOUNTY_BOARD_URL}`
            );
        }
    },

    validateUrl(url: string): void {
        try {
            new URL(url);
        }
        catch (e) {
            throw new ValidationError(
                'Please enter a valid url.\n' +
                // TODO: think whether the following line should be here (likely not) or out of utils
                //'Providing a url is not required, but it makes it easier for your work to be reviewed and for your bounty to be paid out.\n' +
                'If you are having trouble, try navigating to the desired url in your browser. Then copy the url directly from your browser address bar\n' +
                'If you have any questions, please reach out to your favourite bouny board representative!'
            );
        }
    },

    validateNotes(notes: string): void {
        const SUBMIT_NOTES_REGEX = /^[\w\s\W]{1,4000}$/;
        if (notes == null || !SUBMIT_NOTES_REGEX.test(notes)) {
            throw new ValidationError(
                'Please enter notes with a maximum of 4000 characters, and the following requirements: \n' +
                '- alphanumeric\n ' +
                '- special characters: .!@#$%&,?'
                // TODO: think whether the following line should be here (likely not) or out of utils
                //'Providing notes is not required, but it makes it easier for your work to be reviewed and for your bounty to be paid out.\n'
            );
        }
    },

    validatePitch(pitch: string): void {
        const SUBMIT_PITCH_REGEX = /^[\w\s\W]{1,4000}$/;
        if (pitch == null || !SUBMIT_PITCH_REGEX.test(pitch)) {
            throw new ValidationError(
                'Please enter a pitch with a maximum of 4000 characters, and the following requirements: \n' +
                '- alphanumeric\n ' +
                '- special characters: .!@#$%&,?'
            );
        }
    },

    getClaimedAt(bountyRecord: BountyCollection): string | null {
        const statusHistory = bountyRecord.statusHistory;
        if (!statusHistory) {
            return null;
        }

        for (const statusRecord of statusHistory) {
            if (statusRecord.status === BountyStatus.in_progress) {
                return statusRecord.setAt;
            }
        }
        return null;
    },

    /**
     * compares whether two Dates are within 24 hours of each other
     * @param one ISO-8601 representation of a date
     * @param two ISO-8601 representation of a date
     */
    isWithin24Hours(one: string, two: string): boolean {
        const dateOne: Date = new Date(one);
        const dateTwo: Date = new Date(two);
        let elapsedSeconds = Math.abs((dateOne.getTime() - dateTwo.getTime()) / 1000);
        return elapsedSeconds < BountyUtils.TWENTYFOUR_HOURS_IN_SECONDS;
    },

    async createPublicTitle(bountyRecord: Bounty): Promise<string> {
        let title = bountyRecord.title;
        if (bountyRecord.evergreen && bountyRecord.isParent) {
            if (bountyRecord.claimLimit > 1) {
                const claimsAvailable = bountyRecord.claimLimit - (bountyRecord.childrenIds !== undefined ? bountyRecord.childrenIds.length : 0);
                title += `\n(${claimsAvailable} claim${claimsAvailable !== 1 ? "s" : ""} available)`;
            } else {
                title += '\n(Infinite claims available)';
            }
        }
        if (bountyRecord.assignTo) {
            title += `\n(For user ${bountyRecord.assignTo.discordHandle})`
        } else if (bountyRecord.assign) {  //assign is deprecated, replaced by assignTo
            title += `\n(For user ${bountyRecord.assignedName})`
        } else if (bountyRecord.gateTo) {
            title += `\n(For role ${bountyRecord.gateTo[0].discordName})`;  
        } else if (bountyRecord.gate) {  // deprecated, repalced by gateTo
            const role: Role = await DiscordUtils.getRoleFromRoleId(bountyRecord.gate[0], bountyRecord.customerId);
            title += `\n(For role ${role.name})`;
        } else if (bountyRecord.isIOU) {
            title += `\n(IOU owed to ${bountyRecord.claimedBy.discordHandle})`;
        } else {
            if (bountyRecord.requireApplication) {
                title += `\n(Requires application before claiming`;
                if (bountyRecord.applicants) {
                    if (bountyRecord.applicants.length == 1) {
                        title += `. 1 applicant so far.`;
                    } else {
                        title += `. ${bountyRecord.applicants.length} applicants so far.`;
                    }
                }
                title += ')'
            }
        }
        return title;

    },

    async canonicalCard(bountyId: string, activity: string, bountyChannel?: TextChannel, guildMember?: GuildMember): Promise<Message> {
        Log.debug(`Creating/updating canonical card`);

        // Get the updated bounty
        const db: Db = await MongoDbUtils.connect('bountyboard');
        const bountyCollection = db.collection('bounties');
        const bounty: BountyCollection = await bountyCollection.findOne({
            _id: new mongo.ObjectId(bountyId)
        });
        const customerCollection = db.collection('customers');
        const customer: CustomerCollection = await customerCollection.findOne({
            customerId: bounty.customerId,
        });

        // Build the fields, reactions, and footer based on status
        const fields = [
            { name: 'Bounty Id', value: bounty._id.toString(), inline: false },
            { name: 'Criteria', value: bounty.criteria.toString() },
            { name: 'Reward', value: bounty.reward.amount + ' ' + bounty.reward.currency, inline: true },
            { name: 'Status', value: bounty.status, inline: true },
            { name: 'Deadline', value: BountyUtils.formatDisplayDate(bounty.dueAt), inline: true },
            { name: 'Created by', value: bounty.createdBy.discordHandle.toString(), inline: true }
        ];
        if (bounty.gateTo) {
            fields.push({ name: 'For role', value: bounty.gateTo[0].discordName, inline: false })
        } else if (bounty.gate) {  // deprecated, replaced by gateTo
            const role = await DiscordUtils.getRoleFromRoleId(bounty.gate[0], bounty.customerId);
            fields.push({ name: 'For role', value: role.name, inline: false })
        }
        if (bounty.assignTo) {
            fields.push({ name: 'For user', value: bounty.assignTo.discordHandle, inline: false })
        } else if (bounty.assign) {  // assign is deprecated, replaced by assignTo
            const assignedUser = await DiscordUtils.getGuildMemberFromUserId(bounty.assign, bounty.customerId);
            fields.push({ name: 'For user', value: assignedUser.user.tag, inline: false })
        }

        let footer = {};
        let reacts = [];
        let actions = [];
        let color = undefined;

        switch (bounty.status) {
            case BountyStatus.draft:
                footer = { text: '👍 - publish | ❌ - delete | Please reply within 60 minutes', };
                actions.push('👍');
                actions.push('❌');
                break;
            case BountyStatus.open:
                if (bounty.requireApplication && (!bounty.assign) && (!bounty.assignTo)) {
                    footer = { text: '🙋 - apply | ❌ - delete', };
                    actions.push('🙋');
                } else {
                    footer = { text: '🏴 - claim | ❌ - delete', };
                    actions.push('🏴');
                }
                actions.push('❌');
                break;
            case BountyStatus.in_progress:
                color = '#d39e00';
                actions.push('📮');
                actions.push('✅');
                if (bounty.paidStatus !== PaidStatus.paid) {
                    footer = { text: '📮 - submit | ✅ - mark complete | 💰 - mark paid | 🆘 - help', };
                    actions.push('💰');
                } else {
                    footer = { text: '📮 - submit | ✅ - mark complete | 🆘 - help', };
                }
                actions.push('🆘');
                fields.push({ name: 'Claimed by', value: (await DiscordUtils.getGuildMemberFromUserId(bounty.claimedBy.discordId, bounty.customerId)).user.tag, inline: true });
                if (bounty.paidStatus === PaidStatus.paid) fields.push({ name: 'Paid by', value: (await DiscordUtils.getGuildMemberFromUserId(bounty.createdBy.discordId, bounty.customerId)).user.tag, inline: true });
                break;
            case BountyStatus.in_review:
                color = '#d39e00';
                actions.push('✅');
                if (bounty.paidStatus !== PaidStatus.paid) {
                    footer = { text: '✅ - mark complete | 💰 - mark paid | 🆘 - help', };
                    actions.push('💰');
                } else {
                    footer = { text: '✅ - mark complete | 🆘 - help', };
                }
                actions.push('🆘');
                fields.push({ name: 'Claimed by', value: (await DiscordUtils.getGuildMemberFromUserId(bounty.claimedBy.discordId, bounty.customerId)).user.tag, inline: true });
                fields.push({ name: 'Submitted by', value: (await DiscordUtils.getGuildMemberFromUserId(bounty.submittedBy.discordId, bounty.customerId)).user.tag, inline: true });
                if (bounty.paidStatus === PaidStatus.paid) fields.push({ name: 'Paid by', value: (await DiscordUtils.getGuildMemberFromUserId(bounty.createdBy.discordId, bounty.customerId)).user.tag, inline: true });
                break;
            case BountyStatus.complete:
                color = '#01d212';
                reacts.push('🔥');
                if (bounty.paidStatus !== PaidStatus.paid) {
                    footer = { text: '💰 - mark paid', };
                    actions.push('💰');
                }
                fields.push({ name: 'Claimed by', value: (await DiscordUtils.getGuildMemberFromUserId(bounty.claimedBy.discordId, bounty.customerId)).user.tag, inline: true });
                // Bounty might jump directly to Complete status so these would be null...
                if (!!bounty.submittedBy) fields.push({ name: 'Submitted by', value: (await DiscordUtils.getGuildMemberFromUserId(bounty.submittedBy.discordId, bounty.customerId)).user.tag, inline: true });
                if (!!bounty.reviewedBy) fields.push({ name: 'Reviewed by', value: (await DiscordUtils.getGuildMemberFromUserId(bounty.reviewedBy.discordId, bounty.customerId)).user.tag, inline: true });
                if (bounty.paidStatus === PaidStatus.paid) fields.push({ name: 'Paid by', value: (await DiscordUtils.getGuildMemberFromUserId(bounty.createdBy.discordId, bounty.customerId)).user.tag, inline: true });
                break;
        }

        const isDraftBounty = (bounty.status == BountyStatus.draft)
        const createdAt = new Date(bounty.createdAt);

        const actionComponent = actions.map(a => 
            new MessageButton().setEmoji(a).setStyle('SECONDARY').setCustomId(a)
        );

        if (!isDraftBounty && !!customer.lastListMessage) {
            actionComponent.push(
                new MessageButton().setLabel('Back to List').setStyle('LINK').setURL(customer.lastListMessage)
            );
        }

        
        let cardEmbeds: MessageOptions = {
            embeds: [{
                title: await BountyUtils.createPublicTitle(bounty),
                url: (process.env.BOUNTY_BOARD_URL + bounty._id),
                author: {
                    icon_url: (await DiscordUtils.getGuildMemberFromUserId(bounty.createdBy.discordId, bounty.customerId)).user.avatarURL(),
                    name: `${bounty.createdBy.discordHandle}` + (isDraftBounty ? `: ${bounty.customerId}` : ``),
                },
                description: bounty.description,
                fields: fields,
                timestamp: createdAt.getTime(),
                footer: footer,
                color: color,
            }],
            components: actionComponent.length ? [
                new MessageActionRow().addComponents(actionComponent)
            ]
            :
            [],
        };
        

        // Create/Update the card
        let cardMessage: Message;

        if (isDraftBounty) {  // If we are in Create (Draft) mode, put the card in the DM channel
            cardMessage = await (await DiscordUtils.getGuildMemberFromUserId(bounty.createdBy.discordId, bounty.customerId)).send(cardEmbeds);
        } else {
            if (activity == Activities.publish) {  // Publishing. If the card exists, delete it - it was either in a DM or needs to be refreshed
                if (!!bounty.canonicalCard) { 
                    try {
                        const draftChannel = await DiscordUtils.getTextChannelfromChannelId(bounty.canonicalCard.channelId);
                        const draftCardMessage = await DiscordUtils.getMessagefromMessageId(bounty.canonicalCard.messageId, draftChannel);
                        await draftCardMessage.delete();
                    } catch(e) {
                    } finally {
                        bounty.canonicalCard = undefined;
                    }
                }
            }
            if (!!bounty.canonicalCard) {  // If we still have an existing card, try to just edit it, remove old reactions
                try {
                    bountyChannel = await DiscordUtils.getTextChannelfromChannelId(bounty.canonicalCard.channelId);
                    cardMessage = await DiscordUtils.getMessagefromMessageId(bounty.canonicalCard.messageId, bountyChannel);
                    await cardMessage.edit(cardEmbeds);
                    await cardMessage.reactions.removeAll();
                } catch(e) {
                    bounty.canonicalCard = undefined;
                }
            } 
            if (!bounty.canonicalCard) { // If we didn't have a card, or we had an error trying to access it, create it
                if (!bountyChannel) bountyChannel = await DiscordUtils.getBountyChannelfromCustomerId(bounty.customerId);
                try {
                    cardMessage = await bountyChannel.send(cardEmbeds);
                } catch (e) {
                    guildMember &&
                        await guildMember.send({
                            content: `> Failed to publish bounty in **#${bountyChannel.name}**. \n` +
                                `> Reason: ${e.message} \n` +
                                `> Please add bot to **#${bountyChannel.name}** to publish successfully. If issue persists, please contact support \n \n `
                        });

                    bountyChannel = await DiscordUtils.getBountyChannelfromCustomerId(bounty.customerId);

                    guildMember &&
                        await guildMember.send({ content: `Trying to publish on **#${bountyChannel.name}** instead...\n \n ` });
                    cardMessage = await bountyChannel.send(cardEmbeds);
                }
            }
        }
        reacts.forEach(react => {
            cardMessage.react(react);
        });

        // Update the bounty record to reflect the current message state
        await this.updateMessageStore(bounty, cardMessage);

        return cardMessage;

    },

    async notifyAndRemove(messageId: string, channel: TextChannel, cardUrl: string): Promise<any> {
        let message: Message;
        try {
            message = await DiscordUtils.getMessagefromMessageId(messageId, channel)
        } catch {
            Log.error(`Old bounty card message <${messageId}> not found in channel <${channel.id}>`);
        }
        if (!!message) await message.delete();
        await channel.send(`Bounty card has been moved: ${cardUrl}`);
    },

    async updateMessageStore(bounty: BountyCollection, cardMessage: Message): Promise<any> {
        // Delete old cards if they exist. Notify user of new card location with link

        if (bounty.discordMessageId) {
            await this.notifyAndRemove(bounty.discordMessageId, await DiscordUtils.getBountyChannelfromCustomerId(bounty.customerId), cardMessage.url);
        }
        if (!!bounty.creatorMessage) {
            await this.notifyAndRemove(bounty.creatorMessage.messageId, await DiscordUtils.getTextChannelfromChannelId(bounty.creatorMessage.channelId), cardMessage.url);
        }
        if (!!bounty.claimantMessage) {
            await this.notifyAndRemove(bounty.claimantMessage.messageId, await DiscordUtils.getTextChannelfromChannelId(bounty.claimantMessage.channelId), cardMessage.url);
        }

        // Store the card location in the bounty, remove the old cards
        const db: Db = await MongoDbUtils.connect('bountyboard');
        const bountyCollection = db.collection('bounties');
        const writeResult: UpdateWriteOpResult = await bountyCollection.updateOne({ _id: new mongo.ObjectId(bounty._id) }, {
            $unset: {
                claimantMessage: "",
                creatorMessage: "",
                discordMessageId: "",
            },
            $set: {
                canonicalCard: {
                    messageId: cardMessage.id,
                    channelId: cardMessage.channelId,
                },
            },
        });
    },

    async userInputWalletAddress(dmChannel: DMChannel, userId: string, durationMilliseconds: number): Promise<boolean> {
        const replyOptions: AwaitMessagesOptions = {
            max: 1,
            // time is in ms
            time: durationMilliseconds,
            errors: ['time'],
        };

        let numAttempts = 3;
        let walletAddress = '';
        while (numAttempts > 0) {
            walletAddress = await DiscordUtils.awaitUserWalletDM(dmChannel, replyOptions);
            try {
                const upsertWalletRequest = new UpsertUserWalletRequest({
                    userDiscordId: userId,
                    address: walletAddress,
                })

                await handler(upsertWalletRequest);
                break;
            } catch (e) {
                if (e instanceof ValidationError) {
                    if (numAttempts > 1) {
                        await dmChannel.send({ content: `<@${userId}>\n` + e.message });
                    }
                    numAttempts--;
                }
            }
        }

        if (numAttempts === 0) {
            throw new ValidationError('Out of valid user input attempts.');
        }
        else {
            await dmChannel.send(
                `Wallet address ${walletAddress} successfully registered.\n` +
                `Bounty creators will default to using this address when fulfilling transactions for completed bounties.`);
        }

        return true;
    },

    async isUserWalletRegistered(discordUserId: string): Promise<boolean> {
        const db: Db = await MongoDbUtils.connect('bountyboard');
        const userCollection = db.collection('user');

        const dbUserResult: UserCollection = await userCollection.findOne({
            userDiscordId: discordUserId
        });

        if (dbUserResult && dbUserResult.walletAddress) return true;
        return false;
    },

    async getLatestCustomerList(customerId: string): Promise<string> {
        const db: Db = await MongoDbUtils.connect('bountyboard');
        const customerCollection = db.collection('customers');
        const customer: CustomerCollection = await customerCollection.findOne({
            customerId: customerId,
        });

        return customer.lastListMessage;
    },

    // bountyCleanUp 
    //  This is the place to add any db record conversions or other schema or data changes that can be done over time,
    //  and to add data that the web front end might not have access to.
    //
    //  It will be called after each activity that affects a bounty record.
    //
    async bountyCleanUp(bountyId: string): Promise<any> {
        const db: Db = await MongoDbUtils.connect('bountyboard');
        const bountyCollection = db.collection('bounties');
        const bounty: BountyCollection = await bountyCollection.findOne({
            _id: new mongo.ObjectId(bountyId)
        });

        const fixedBounty = await this.fixBounty(bounty);

        await bountyCollection.replaceOne({ _id: new mongo.ObjectId(bounty._id) }, fixedBounty);

        // If evergreen parent, fix last created child also
        if (bounty.childrenIds) {
            const childBounty: BountyCollection = await bountyCollection.findOne({
            _id: new mongo.ObjectId(bounty.childrenIds[bounty.childrenIds.length -1])
             });
             await this.fixBounty(childBounty);
        }
    },

    async fixBounty(bounty: BountyCollection): Promise<any> {
    
        const customerId = bounty.customerId;

        // If the user avatar URLs are missing, this bounty was probably created on the web. Populate the URLs
        if (bounty.createdBy && !bounty.createdBy.iconUrl) {
            bounty.createdBy.iconUrl = (await DiscordUtils.getGuildMemberFromUserId(bounty.createdBy.discordId, customerId)).user.avatarURL();
        }
        if (bounty.claimedBy && !bounty.claimedBy.iconUrl) {
            bounty.claimedBy.iconUrl = (await DiscordUtils.getGuildMemberFromUserId(bounty.claimedBy.discordId, customerId)).user.avatarURL();
        }
        if (bounty.submittedBy && !bounty.submittedBy.iconUrl) {
            bounty.submittedBy.iconUrl = (await DiscordUtils.getGuildMemberFromUserId(bounty.submittedBy.discordId, customerId)).user.avatarURL();
        }
        if (bounty.reviewedBy && !bounty.reviewedBy.iconUrl) {
            bounty.reviewedBy.iconUrl = (await DiscordUtils.getGuildMemberFromUserId(bounty.reviewedBy.discordId, customerId)).user.avatarURL();
        }
        if (bounty.applicants) {
            bounty.applicants.forEach( async (a, i) => {
                if (!a.iconUrl) {
                    bounty.applicants[i].iconUrl = (await DiscordUtils.getGuildMemberFromUserId(a.discordId, customerId)).user.avatarURL();
                }
            })
        }

        // If assignTo is missing, create it from the deprecated assign item
        if (bounty.assign && !bounty.assignTo) {
            const assignedUser = await DiscordUtils.getGuildMemberFromUserId(bounty.assign, customerId)
            bounty.assignTo = {discordId: assignedUser.user.id, discordHandle: assignedUser.user.tag, iconUrl: assignedUser.user.avatarURL()};
        }

        // If gateTo is missing, create it from the deprecated gate item
        if (bounty.gate && !bounty.gateTo) {
            const gatedTo = await DiscordUtils.getRoleFromRoleId(bounty.gate[0], customerId)
            bounty.gateTo = [{discordId: gatedTo.id, discordName: gatedTo.name, iconUrl: gatedTo.iconURL() }];
        }

        return bounty;
    },

}

export default BountyUtils;