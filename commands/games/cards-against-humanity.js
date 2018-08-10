const { Command, Argument } = require('discord-akairo');
const { Collection, escapeMarkdown } = require('discord.js');
const { stripIndents } = require('common-tags');
const { shuffle, awaitPlayers } = require('../../util/Util');
const { blackCards, whiteCards } = require('../../assets/json/cards-against-humanity');
const { SUCCESS_EMOJI_ID, FAILURE_EMOJI_ID } = process.env;

module.exports = class CardsAgainstHumanityCommand extends Command {
	constructor() {
		super('cards-against-humanity', {
			aliases: ['cards-against-humanity', 'crude-cards', 'pretend-youre-xyzzy', 'cah'],
			category: 'games',
			description: 'Compete to see who can come up with the best card to fill in the blank.',
			channel: 'guild',
			clientPermissions: ['ADD_REACTIONS', 'READ_MESSAGE_HISTORY'],
			args: [
				{
					id: 'maxPts',
					prompt: {
						start: 'What amount of points should determine the winner?',
						retry: 'You provided an invalid points maximum. Please try again.'
					},
					type: Argument.range('integer', 1, 20, true)
				}
			]
		});

		this.playing = new Set();
	}

	async exec(msg, { maxPts }) {
		if (this.playing.has(msg.channel.id)) return msg.util.reply('Only one game may be occurring per channel.');
		this.playing.add(msg.channel.id);
		let joinLeaveCollector = null;
		try {
			await msg.util.sendNew('You will need at least 2 more players, at maximum 10. To join, type `join game`.');
			const awaitedPlayers = await awaitPlayers(msg, 10, 3);
			if (!awaitedPlayers) {
				this.playing.delete(msg.channel.id);
				return msg.util.sendNew('Game could not be started...');
			}
			const players = new Collection();
			for (const user of awaitedPlayers) this.generatePlayer(user, players);
			const czars = players.map(player => player.id);
			let winner = null;
			let counter = 0;
			joinLeaveCollector = this.createJoinLeaveCollector(msg.channel, players, czars);
			while (!winner) {
				const czar = players.get(czars[0]);
				czars.push(czar.id);
				czars.shift();
				const black = blackCards[Math.floor(Math.random() * blackCards.length)];
				await msg.util.sendNew(stripIndents`
					The card czar will be ${czar.user}!
					The Black Card is: **${escapeMarkdown(black.text)}**

					Sending DMs...
				`);
				const chosenCards = [];
				const turns = players.map(async player => {
					if (player.hand.size < 11) {
						const valid = whiteCards.filter(card => !player.hand.has(card));
						player.hand.add(valid[Math.floor(Math.random() * valid.length)]);
					}
					if (player.user.id === czar.user.id) return;
					try {
						if (player.hand.size < black.pick) {
							await player.user.send('You don\'t have enough cards!');
							return;
						}
						const hand = Array.from(player.hand);
						await player.user.send(stripIndents`
							__**Your hand is**__:
							${hand.map((card, i) => `**${i + 1}.** ${card}`).join('\n')}

							**Black Card**: ${escapeMarkdown(black.text)}
							**Card Czar**: ${czar.user.username}
							Pick **${black.pick}** card${black.pick > 1 ? 's' : ''}!
						`);
						const chosen = [];
						const filter = res => {
							const existing = hand[Number.parseInt(res.content, 10) - 1];
							if (!existing) return false;
							if (chosen.includes(existing)) return false;
							chosen.push(existing);
							return true;
						};
						const choices = await player.user.dmChannel.awaitMessages(filter, {
							max: black.pick,
							time: 120000
						});
						if (!choices.size || choices.size < black.pick) {
							await player.user.send('Skipping your turn...');
							return;
						}
						if (chosen.includes('<Blank>')) {
							const handled = await this.handleBlank(player);
							chosen[chosen.indexOf('<Blank>')] = handled;
						}
						for (const card of chosen) player.hand.delete(card);
						chosenCards.push({
							id: player.id,
							cards: chosen
						});
						await player.user.send(`Nice! Return to ${msg.channel} to await the results!`);
					} catch (err) {
						return; // eslint-disable-line no-useless-return
					}
				});
				await Promise.all(turns);
				if (!chosenCards.length) {
					await msg.util.sendNew('Hmm... No one even tried.');
					counter += 1;
					if (counter > 1) break;
					continue;
				}
				const cards = shuffle(chosenCards);
				await msg.util.sendNew(stripIndents`
					${czar.user}, which card${black.pick > 1 ? 's' : ''} do you pick?
					**Black Card**: ${escapeMarkdown(black.text)}

					${cards.map((card, i) => `**${i + 1}.** ${card.cards.join(', ')}`).join('\n')}
				`);
				const filter = res => {
					if (res.author.id !== czar.user.id) return false;
					if (!cards[Number.parseInt(res.content, 10) - 1]) return false;
					return true;
				};
				const chosen = await msg.channel.awaitMessages(filter, {
					max: 1,
					time: 120000
				});
				if (!chosen.size) {
					await msg.util.sendNew('Hmm... No one wins.');
					counter += 1;
					if (counter > 1) break;
					continue;
				}
				if (counter !== 0) counter = 0;
				const player = players.get(cards[Number.parseInt(chosen.first().content, 10) - 1].id);
				if (!player) {
					await msg.util.sendNew('Oh no, I think that player left! No points will be awarded...');
					continue;
				}
				++player.points;
				if (player.points >= maxPts) winner = player.user;
				else await msg.util.sendNew(`Nice one, ${player.user}! You now have **${player.points}** points!`);
			}
			joinLeaveCollector.stop();
			this.playing.delete(msg.channel.id);
			if (!winner) return msg.util.sendNew('See you next time!');
			return msg.util.sendNew(`And the winner is... ${winner}! Great job!`);
		} catch (err) {
			this.playing.delete(msg.channel.id);
			if (joinLeaveCollector) joinLeaveCollector.stop();
			return msg.util.reply(`Oh no, an error occurred: \`${err.message}\`. Try again later!`);
		}
	}

	generatePlayer(user, players) {
		const cards = new Set();
		for (let i = 0; i < 5; i++) {
			const valid = whiteCards.filter(card => !cards.has(card));
			cards.add(valid[Math.floor(Math.random() * valid.length)]);
		}
		players.set(user.id, {
			id: user.id,
			user,
			points: 0,
			hand: cards
		});
		return players;
	}

	async handleBlank(player) {
		await player.user.send('What do you want the blank card to say? Must be 100 or less characters.');
		const blank = await player.user.dmChannel.awaitMessages(res => res.content.length <= 100, {
			max: 1,
			time: 120000
		});
		player.hand.delete('<Blank>');
		if (!blank.size) return `A blank card ${player.user.tag} forgot to fill out.`;
		return blank.first().content;
	}

	createJoinLeaveCollector(channel, players, czars) {
		const filter = res => {
			if (res.author.bot) return false;
			if (players.has(res.author.id) && res.content.toLowerCase() !== 'leave game') return false;
			if (czars[0] === res.author.id) {
				res.react(FAILURE_EMOJI_ID || '❌').catch(() => null);
				return false;
			}
			if (!['join game', 'leave game'].includes(res.content.toLowerCase())) return false;
			res.react(SUCCESS_EMOJI_ID || '✅').catch(() => null);
			return true;
		};
		const collector = channel.createMessageCollector(filter);
		collector.on('collect', msg => {
			if (msg.content.toLowerCase() === 'join game') {
				players.set(msg.author.id, msg.author);
				czars.push(msg.author.id);
			} else if (msg.content.toLowerCase() === 'leave game') {
				players.delete(msg.author.id);
				czars.splice(czars.indexOf(msg.author.id), 1);
			}
		});
		return collector;
	}
};
