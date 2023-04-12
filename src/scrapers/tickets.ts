import * as cheerio from 'cheerio';
import { Database } from 'sqlite3';
import { TicketReply, TicketUpload, Tickets } from '../interfaces/tickets';
import { insertRow } from '../util/database';
import { addExitListeners, removeExitListeners } from '../util/exit';
import { fileExists, parseJsonFile } from '../util/files';
import { enjinRequest, getRequest } from '../util/request';
import { SiteAuth } from '../interfaces/generic';

async function getTicketModules(database: Database, domain: string, apiKey: string): Promise<string[]> {

    const params = {
        api_key: apiKey,
    }
    const data = await enjinRequest<Tickets.GetModules>(params, 'Tickets.getModules', domain);
    const userDB: [
        string, 
        string | null
    ][] = [];

    if (data.error) {
        console.log(`Error getting ticket modules: ${data.error.code} ${data.error.message}`)
        return [];
    }

    if (Object.keys(data.result).length > 0) {
        Object.keys(data.result).forEach((module) => {
            const result = data.result[module]
            userDB.push([
                result.module_name,
                JSON.stringify(result.questions)
            ]);
        });
    }

    if (userDB && userDB.length > 0) {
        await insertRow(database, 'scrapers', 'ticket_modules', false);
    }

    return Object.keys(data.result);
}

async function getTicketReplies(domain: string, sessionID: string, ticketCode: string): Promise<[TicketReply[], boolean]> {
    let page = [1];
    let lastPage = [1];
    let replies: TicketReply[] = [];
    let has_uploads = false;

    while (page[0] <= lastPage[0]) {
        const params = {
            session_id: sessionID,
            ticket_code: ticketCode,
            page: page[0].toString(),
        }

        const data = await enjinRequest<Tickets.GetReplies>(params, 'Tickets.getReplies', domain);

        if (data.error) {
            console.log(`Error getting replies for ticket ${ticketCode}: ${data.error.code} ${data.error.message}`)
            break;
        }

        lastPage[0] = data.result.pagination.last_page;

        replies.push(...data.result.results);
        has_uploads = data.result.has_uploads;
        page[0]++;
    }

    return [replies, has_uploads];
}

async function getTicketsByModule(database: Database, domain: string, sessionID: string, siteAuth: SiteAuth, modules: string[]) {
    const moduleCount = [0];
    const ticketCount = [0];
    let totalModules = modules.length;
    let tickets = 0;
    let page = [1];
    let lastPage = [1];

    if (fileExists('./target/recovery/module_tickets.json')) {
        const progress = parseJsonFile('./target/recovery/module_tickets.json') as [string[], number[], number[], number[], number[]];
        modules = progress[0];
        totalModules = modules.length;
        moduleCount[0] = progress[1][0];
        ticketCount[0] = progress[2][0];
        page[0] = progress[3][0];
        lastPage[0] = progress[4][0];
    }

    addExitListeners(['./target/recovery/module_tickets.json'], [[modules, moduleCount, ticketCount, page, lastPage]]);

    for (let i = moduleCount[0]; i < totalModules; i++) {
        while (page[0] <= lastPage[0]) {
            const params = {
                session_id: sessionID,
                preset_id: modules[i],
                status: 'all',
                page: page[0].toString(),
            }
            const data = await enjinRequest<Tickets.GetTickets>(params, 'Tickets.getTickets', domain);

            if (data.error) {
                console.log(`Error getting tickets for module ${modules[i]} page ${page[0]}: ${data.error.code} ${data.error.message}`)
                break;
            }

            lastPage[0] = data.result.pagination.nr_pages;
            tickets += data.result.results.length;
            console.log(`Scraping tickets for module ${modules[i]} page (${page[0]}/${lastPage}) module (${moduleCount[0]+1}/${totalModules})...`);

            for (let j = ticketCount[0]; j < data.result.results.length; j++) {
                const ticket = data.result.results[j];
                const [replies, has_uploads] = await getTicketReplies(domain, sessionID, ticket.code);
                const values = [
                    ticket.id,
                    ticket.code,
                    ticket.site_id,
                    ticket.preset_id,
                    ticket.subject,
                    ticket.created,
                    ticket.status,
                    ticket.assignee,
                    ticket.updated,
                    ticket.requester,
                    ticket.priority,
                    ticket.extra_questions,
                    ticket.status_change,
                    ticket.email,
                    ticket.viewers,
                    ticket.createdHTML,
                    ticket.updatedHTML,
                    ticket.requesterHTML,
                    ticket.assigneeText,
                    ticket.assigneeHTML,
                    ticket.priority_name,
                    ticket.replies_count,
                    ticket.private_reply_count,
                    JSON.stringify(replies),
                    has_uploads,
                    null
                ];
                if (has_uploads) {
                    const uploads = await getTicketUploads(domain, siteAuth, ticket.code, ticket.preset_id);
                    values[values.length-1] = JSON.stringify(uploads);
                }
                await insertRow(database, 'tickets', ...values);
                console.log(`Scraping ticket ${ticket.id} (${++ticketCount[0]}/${data.result.results.length}) page (${page[0]}/${lastPage}) module (${moduleCount[0]+1}/${totalModules})...`);
            }
            ticketCount[0] = 0;
            page[0]++;
        }
        page[0] = 1;
        console.log(`Scraped all tickets for module ${modules[i]}. (${++moduleCount[0]}/${totalModules})`);
        tickets = 0;
    }
    removeExitListeners();
}

async function getTicketUploads(domain: string, siteAuth: SiteAuth, ticketCode: string, ticketModule: String): Promise<TicketUpload[]> {
    const homeResponse = await getRequest(domain, `/ajax.php?code=${ticketCode}&s=editmodule_tickets&cmd=ticket_html&preset_id=${ticketModule}&saved_data%5Bmode%5D=public`, {
        Cookie: `${siteAuth.phpSessID}; ${siteAuth.csrfToken}`,
    });

    const uploads: TicketUpload[] = [];
    const $ = cheerio.load(homeResponse.data);

    $(".uploads-container .each-upload").each((_index, element) => {
        const $element = $(element);
        const href = $element.find("a").attr("href");
        if (href) {
            const uploader = $element.find(".uploaded-by-column .element_username").text();
            const filename = $element.find(".float-left a").text().trim();
            const timestamp = parseInt(href.split("-")[1], 10);
            uploads.push({ href, uploader, filename, timestamp });
        }
    });

    console.log(`Found ${uploads.length} uploads for ticket ${ticketCode}.`)

    return uploads;
}

export async function getAllTickets(database: Database, domain: string, apiKey: string, sessionID: string, siteAuth: SiteAuth) {
    console.log('Getting all tickets...');
    let modules: string[];
    if (fileExists('./target/recovery/module_tickets.json')) {
        modules = [];
    } else {
        modules = await getTicketModules(database, domain, apiKey);
    }
    console.log(`Found ${modules.length} ticket modules: ${modules.join(', ')}.`);
    await getTicketsByModule(database, domain, sessionID, siteAuth, modules);
}