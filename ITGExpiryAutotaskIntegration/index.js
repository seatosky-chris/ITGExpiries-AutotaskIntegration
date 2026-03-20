/**
 * File: \ITGExpiryAutotaskIntegration\index.js
 * Project: itgexpiries-autotaskintegration
 * Created Date: Tuesday, August 2nd 2022, 10:01:30 am
 * Author: Chris Jantzen
 * -----
 * Last Modified: Fri Mar 20 2026
 * Modified By: Chris Jantzen
 * -----
 * Copyright (c) 2023 Sea to Sky Network Solutions
 * License: MIT License
 * -----
 * 
 * HISTORY:
 * Date      	By	Comments
 * ----------	---	----------------------------------------------------------
 */

const { app } = require('@azure/functions');
const {AutotaskRestApi} = require('@apigrate/autotask-restapi');
const { ITGlueClient } = require('@panoptic-it-solutions/itglue-client');
const dns = require('dns');
const https = require('https');

app.http('ITGExpiryAutotaskIntegration', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (req, context) => {
        context.log('JavaScript HTTP trigger function processed a request.');
        const params = await req.json();

        const testType = (params && params.testType);
        const organizationName = (params && params.organizationName);
        const resourceName = (params && params.resourceName);
        const resourceTimeToExpiry = (params && params.resourceTimeToExpiry);
        const resourceUrl = (params && params.resourceUrl);

        context.log(`Test Type: ${testType}, Org: ${organizationName}, Resource: ${resourceName}, Time To Expiry: ${resourceTimeToExpiry}, URL: ${resourceUrl}`);
        context.log(`Original Url: ${req.url}, Method: ${req.method}`);

        const responseMessage = resourceName
            ? "Test: '" + testType + "' on '" + resourceName + "' was triggered. Org: " + organizationName +
                " \n Time to Expiry: " + resourceTimeToExpiry +
                " \n Url: " + resourceUrl
            : "This HTTP triggered function executed successfully.";

        if (testType != "Domain Expiry" && testType != "SSL Expiry" && testType != "Flexible Asset Expiry") {
            context.warn("Test Type '" + testType + "' is not supported. Exiting...");
            context.error("testType: " + testType + ", orgName: " + organizationName + ", resourceName: " + resourceName + ", timeToExpiry: " + resourceTimeToExpiry + ", resourceUrl: " + resourceUrl);
            return {
                status: 400,
                body: "Test Type '" + testType + "' is not supported. Exiting..."
            };
        }


        // Connect to the Autotask API
        const autotask = new AutotaskRestApi(
            process.env.AUTOTASK_USER,
            process.env.AUTOTASK_SECRET, 
            process.env.AUTOTASK_INTEGRATION_CODE 
        );

        // Connect to the ITG API
        const itgclient = new ITGlueClient(process.env.ITG_API_KEY, {
            baseURL: 'https://api.itglue.com',
            timeout: 20000, // request timeout in ms
            retries: 3 // number of retries on failure
        });

        // Verify the Autotask API key works (the library doesn't always provide a nice error message)
        var useAutotaskAPI = true;
        var autotaskTest = await autotask.Companies.get(0); // we need to do a call for the autotask module to get the zone info
        try {
            let fetchParms = {
                method: 'GET',
                headers: {
                "Content-Type": "application/json",
                "User-Agent": "Apigrate/1.0 autotask-restapi NodeJS connector"
                }
            };
            fetchParms.headers.ApiIntegrationcode = process.env.AUTOTASK_INTEGRATION_CODE;
            fetchParms.headers.UserName =  process.env.AUTOTASK_USER;
            fetchParms.headers.Secret = process.env.AUTOTASK_SECRET;

            let test_url = `${autotask.zoneInfo ? autotask.zoneInfo.url : autotask.base_url}V${autotask.version}/Companies/entityInformation`;
            let response = await fetch(`${test_url}`, fetchParms);
            if(!response.ok){
                var result = await response.text();
                if (!result) {
                    result = `${response.status} - ${response.statusText}`;
                }
                throw result;
            } else {
                context.log(`Successfully connected to Autotask. (${response.status} - ${response.statusText})`)
            }
        } catch (error) {
            if (error.startsWith("401")) {
                error = `API Key Unauthorized. (${error})`
            }
            context.error(error);
            useAutotaskAPI = false;
        }

        // Get org info from ITG
        let itgOrganization;

        try {
            const itgOrgs = await itgclient.organizations.list({
                filters: { name: organizationName }
            })

            itgOrganization = itgOrgs?.data?.[0];

            if (!itgOrganization) {
                context.error(`Could not find organization '${organizationName}' in ITGlue data.`);
            }
        } catch (error) {
            context.error('API Error getting Organization:', error?.message || error);
        }

        if (!itgOrganization) {
            context.error(`No organization information found for '${organizationName}'. Exiting...`);
            return {
                status: 404,
                body: `No organization information found for '${organizationName}'. Exiting...`
            };
        }

        // Find company in Autotask
        let autotaskCompanies = false;
        if (useAutotaskAPI) {
            autotaskCompanies = await autotask.Companies.query({
                filter: [
                    {
                        "op": "contains",
                        "field": "CompanyName",
                        "value": organizationName
                    }
                ],
                includeFields: [
                    "id", "companyName", "companyNumber", "isActive"
                ]
            }); 

            if ((!autotaskCompanies || autotaskCompanies.items.length < 1) && itgOrganization && itgOrganization["short-name"]) {
                autotaskCompanies = await autotask.Companies.query({
                    filter: [
                        {
                            "op": "or",
                            "items": [
                                {
                                    "op": "eq",
                                    "field": "CompanyNumber",
                                    "value": itgOrganization["short-name"]
                                },
                                {
                                    "op": "eq",
                                    "field": "Client Abbreviation",
                                    "value": itgOrganization["short-name"],
                                    "udf": true
                                }
                            ]
                        }
                    ],
                    includeFields: [
                        "id", "companyName", "companyNumber", "isActive"
                    ]
                }); 
            }

            // Filter down if multiple companies found and remove any inactive
            if (autotaskCompanies && autotaskCompanies.items.length > 0) {

                autotaskCompanies = autotaskCompanies.items.filter(company => {
                    return company.isActive == true;
                });

                if (autotaskCompanies.length > 1) {
                    autotaskCompanies = autotaskCompanies.filter(company => {
                        return (organizationName.toLowerCase()).search(company.companyName.toLowerCase()) > -1;
                    });
                    if (autotaskCompanies.length > 1) {
                        autotaskCompanies = [];
                    }
                }
            }
        }

        // If no company found, default to 0 as the default
        if (!autotaskCompanies || autotaskCompanies.length !== 1) {
            autotaskCompanies = [
                {
                    id: 0,
                    isActive: true,
                    companyName: "",
                    companyNumber: ""   
                }
            ];
        }

        // Get primary location and default contract
        var contractID = null;
        var location = null;
        if (useAutotaskAPI && autotaskCompanies && autotaskCompanies.length == 1) {
            let locations = await autotask.CompanyLocations.query({
                filter: [
                    {
                        "op": "eq",
                        "field": "CompanyID",
                        "value": autotaskCompanies[0].id
                    }
                ],
                includeFields: [
                    "id", "isActive", "isPrimary"
                ]
            });

            locations = locations.items.filter(location => location.isActive);

            var location;
            if (locations.length > 0) {
                location = locations.filter(location => location.isPrimary);
                location = location[0];
                if (!location) {
                    location = locations[0];
                }
            } else {
                location = locations[0];
            }

            let contract = await autotask.Contracts.query({
                filter: [
                    {
                        "op": "and",
                        "items": [
                            {
                                "op": "eq",
                                "field": "CompanyID",
                                "value": autotaskCompanies[0].id
                            },
                            {
                                "op": "eq",
                                "field": "IsDefaultContract",
                                "value": true
                            }
                        ]
                    }
                ],
                includeFields: [ "id" ]
            });
            
            if (contract.items.length > 0) {
                contractID = contract.items[0].id
            }
        }

        // Connect to ITG API and get details
        if (testType == "Domain Expiry") {

            let itgDomainInfo;

            try {
                const itgDomains = await itgclient.domains.list({
                    filters: { organization_id: itgOrganization.id },
                    page: 1, 
                    pageSize: 1000
                })

                itgDomainInfo = itgDomains?.data?.find(d => d.attributes.name == resourceName);

                if (!itgDomainInfo) {
                    context.error(`Could not get the domains from ITGlue for organization '${organizationName}'.`);
                }
            } catch (error) {
                context.error('API Error getting Domain:', error?.message || error);
            }

            if (!itgDomainInfo) {
                context.error(`No domain information found for '${resourceName}'. Exiting...`);
                return {
                    status: 404,
                    body: `No domain information found for '${resourceName}'. Exiting...`
                };
            }

            if (itgDomainInfo?.attributes?.notes && itgDomainInfo?.attributes?.notes?.includes("# Ignore Alerts")) {
                return {
                    body: "The expiring domain '" + resourceName + "' was ignored. Exiting..."
                };
            }

            var expiresOn;
            if (itgDomainInfo) {
                expiresOn = new Date(itgDomainInfo.attributes["expires-on"]);
            }

            var detailedNotes = "";
            if (itgDomainInfo) {
                detailedNotes = 'Additional Details \n';
                detailedNotes += '-----------------------\n';
                detailedNotes += `Registrar Name: ${itgDomainInfo.attributes["registrar-name"]} \n`;
                if (itgDomainInfo.attributes["notes"]) {
                    detailedNotes += `Notes: ${itgDomainInfo.attributes["notes"]} \n`;
                }
                if (expiresOn) {
                    detailedNotes += `Expires On: ${expiresOn.toLocaleDateString('en-ca', { weekday:"long", year:"numeric", month:"short", day:"numeric"})} \n`;
                }
                detailedNotes += `ITG Url: ${resourceUrl}`;
            }

            var title = `Domain Expiring: ${resourceName}`;
            var description = `Alert from IT Glue.\n`;
            if (autotaskCompanies[0].id == 0) {
                description += `Organization: ${organizationName}\n`;
            }
            description += `The domain '${resourceName}' is expiring in ${resourceTimeToExpiry}. \n\n\n${detailedNotes}`;
        } else if (testType == "SSL Expiry") {

            let itgSSLInfo;

            try {
                const itgExpirations = await itgclient.expirations.list({
                    filters: { 
                        organization_id: itgOrganization.id,
                        resource_type_name: "SslCertificate"
                    },
                    page: 1, 
                    pageSize: 1000
                })

                itgSSLInfo = itgExpirations?.data?.find(d => d.attributes['resource-name'] == resourceName);

                if (!itgSSLInfo) {
                    context.error(`Could not find SSL certificate '${resourceName}' in ITGlue data.`);
                }
            } catch (error) {
                context.error('API Error getting SSL certificate:', error?.message || error);
            }

            if (!itgSSLInfo) {
                context.error(`No SSL certificate information found for '${resourceName}'. Exiting...`);
                return {
                    status: 404,
                    body: `No SSL certificate information found for '${resourceName}'. Exiting...`
                };
            }

            var ipAddress = null;
            var certIssuer = null;
            if (!resourceName.startsWith("*")) {
                // Get more info on the cert if it is connected to a domain
                try {
                    context.log(`Attempting to lookup ip from the domain: ${resourceName}`)
                    ipAddress = await ipLookupFromDomain(resourceName);
                } catch(err) {
                    context.warn(`${resourceName} is not a valid domain. IP lookup failed.`);
                }
                context.log('IP Lookup for domain complete.')

                /// TODO: Perhaps only do this if we successfully got ipAddress info above
                try {
                    context.log(`Attempting to lookup SSL Issuer from the domain: ${resourceName}`)
                    certIssuer = await sslIssuerLookupFromDomain(resourceName);
                } catch (err) {
                    context.warn(`SSL Issuer lookup failed for: ${resourceName}`);
                }
                context.log('SSL Issuer Lookup for domain complete.')
            }

            if (certIssuer && certIssuer == "Let\'s Encrypt") {
                context.warn("SSL Cert '" + resourceName + "' is registered with Let's Encrypt. Exiting...");
                return {
                    status: 400,
                    body: "SSL Cert '" + resourceName + "' is registered with Let's Encrypt. Exiting..."
                };
            }

            var expiresOn;
            if (itgSSLInfo) {
                expiresOn = new Date(itgSSLInfo.attributes["expiration-date"]);
            }

            var detailedNotes = "";
            if (expiresOn) {
                detailedNotes = 'Additional Details \n';
                detailedNotes += '-----------------------\n';
                if (ipAddress) {
                    detailedNotes += `Host IP Address: ${ipAddress} \n`;
                }
                if (certIssuer) {
                    detailedNotes += `Issuer: ${certIssuer} \n`;
                }
                detailedNotes += `Expires On: ${expiresOn.toLocaleDateString('en-ca', { weekday:"long", year:"numeric", month:"short", day:"numeric"})} \n`;
                detailedNotes += `ITG Url: ${resourceUrl}`;
            }

            var title = `SSL Cert Expiring: ${resourceName}`;
            var description = `Alert from IT Glue.\n`;
            if (autotaskCompanies[0].id == 0) {
                description += `Organization: ${organizationName}\n`;
            }
            description += `The ssl cert '${resourceName}' is expiring in ${resourceTimeToExpiry}. \n\n\n${detailedNotes}`;
        } else if (testType == "Flexible Asset Expiry") {
            var match = resourceUrl.match(/(?:\/)(\d+?)(?:$)/);
            var assetID = match[1];

            let flexAssetInfo;

            try {
                const itgFlexAssets = await itgclient.flexibleAssets.get(assetID);
                flexAssetInfo = itgFlexAssets?.data;
            } catch (error) {
                context.error('API Error getting Flexible Asset:', error?.message || error);
            }

            if (!flexAssetInfo) {
                context.error(`The flexible asset '${resourceName}' was not found in ITG. Exiting...`);
                return {
                    status: 404,
                    body: `The flexible asset '${resourceName}' was not found in ITG. Exiting...`
                };
            }

            const expiries = {};
            if (flexAssetInfo) {
                Object.entries(flexAssetInfo.attributes.traits)
                    .filter(([key]) => key.toLowerCase().includes('expiry') || key.toLowerCase().includes('expire'))
                    .forEach(([key, value]) => {
                        const date = new Date(value);
                        if (!isNaN(date.getTime())) {
                            expiries[key] = date;
                        }
                    });
            }

            let expiresOn = findSoonestFutureDate(expiries);

            var detailedNotes = "";
            if (flexAssetInfo) {
                detailedNotes = 'Additional Details \n';
                detailedNotes += '-----------------------\n';
                if (flexAssetInfo.attributes["notes"]) {
                    detailedNotes += `Notes: ${flexAssetInfo.attributes.traits["notes"]} \n`;
                }
                if (expiries) {
                    detailedNotes += `Related Expiry Dates: \n`
                    Object.entries(expiries).forEach(([key, date]) => {
                        detailedNotes += `${formatAttributeName(key)}: ${date.toLocaleDateString('en-ca', { weekday:"long", year:"numeric", month:"short", day:"numeric"})}\n`;
                    });
                }
                detailedNotes += `ITG Url: ${resourceUrl}`;
            }

            var title = `Upcoming Expiry - ${flexAssetInfo.attributes["flexible-asset-type-name"]}: ${resourceName}`;
            var description = `Alert from IT Glue.\n`;
            if (autotaskCompanies[0].id == 0) {
                description += `Organization: ${organizationName}\n`;
            }
            description += `The '${flexAssetInfo.attributes["flexible-asset-type-name"]}' asset '${resourceName}' is expiring in ${resourceTimeToExpiry}. \n\n\n${detailedNotes}`;
        }

        // Make a new ticket
        let newTicket = {
            CompanyID: (autotaskCompanies ? autotaskCompanies[0].id : 0),
            CompanyLocationID: (location ? location.id : 10),
            Priority: 3,
            Status: 1,
            QueueID: parseInt(process.env.TICKET_QueueID),
            IssueType: parseInt(process.env.TICKET_IssueType),
            SubIssueType: parseInt(process.env.TICKET_SubIssueType),
            ServiceLevelAgreementID: parseInt(process.env.TICKET_ServiceLevelAgreementID),
            ContractID: (contractID ? contractID : null),
            Title: title,
            Description: description
        };
        if (expiresOn) {
            newTicket.DueDateTime = expiresOn.toISOString()
        }

        var ticketID = null;
        try {
            result = await autotask.Tickets.create(newTicket);
            ticketID = result.itemId;
            if (!ticketID) {
                throw "No ticket ID";
            } else {
                context.log("New ticket created: " + ticketID);
            }
        } catch (error) {
            // Send an email to support if we couldn't create the ticket
            var mailBody = {
                From: {
                    Email: process.env.EMAIL_FROM__Email,
                    Name: process.env.EMAIL_FROM__Name
                },
                To: [
                    {
                        Email: process.env.EMAIL_TO__Email,
                        Name: process.env.EMAIL_TO__Name
                    }
                ],
                "Subject": title,
                "HTMLContent": description.replace(new RegExp('\r?\n','g'), "<br />")
            }

            try {
                let emailResponse = await fetch(process.env.EMAIL_API_ENDPOINT, {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'x-api-key': process.env.EMAIL_API_KEY
                    },
                    method: "POST",
                    body: JSON.stringify(mailBody)
                });
                context.warn("Ticket creation failed. Backup email sent to support.");
            } catch (error) {
                context.error("Ticket creation failed. Sending an email as a backup also failed.");
                context.error(error);
            }
            ticketID = null;
        }

        return {
            // status: 200, /* Defaults to 200 */
            body: responseMessage
        };
    }
});


async function ipLookupFromDomain(domain) {
    return new Promise((resolve, reject) => {
        dns.lookup(domain, (err, address, family) => {
            if (err) reject(err);
            resolve(address);
        });
    });
};

async function sslIssuerLookupFromDomain(domain) {
    const options = {
        hostname: domain,
        port: 443,
        method: 'get',
        headers: {
            'User-Agent': 'Node/https'
        },
        //disable session caching   (ノ°Д°）ノ︵ ┻━┻
        agent: new https.Agent({
            maxCachedSessions: 0
        })
    };

    return new Promise((resolve, reject) => {
        let req = https.request(options);

        req.on('error', reject);

        req.on('socket', function(socket) {
            socket.on('secureConnect', function() {
                let certInfo = socket.getPeerCertificate();

                if (certInfo && certInfo.issuer && certInfo.issuer.O) {
                    resolve(certInfo.issuer.O);
                } else {
                    resolve(null);
                }
            });
        });
        req.end();
    });
}

/**
 * Finds the soonest future date from an object containing date properties.
 * @param {Object} dateObject - Object containing date properties to search through
 * @returns {Date|null} - Soonest future date, or null if none found
 */
const findSoonestFutureDate = (dateObject) => {
    const now = new Date();
    
    // Filter for future dates
    const futureDates = Object.values(dateObject)
        .filter(date => date > now);

    // Return null if no future dates exist
    if (futureDates.length === 0) {
        return null;
    }

    // Find the earliest future date
    return futureDates.reduce((earliest, current) => 
        current < earliest ? current : earliest
    );
};

/**
 * Formats an ITG attribute name into a readable format for output into the ticket description
 * You can add custom replacements to format specific things nicely (e.g. see the VPP/APN code)
 * @param {string} key - The attribute name or key
 * @returns {string} - The formatted name
 */
const formatAttributeName = (key) => {
    let formattedKey = key.replace(/-/g, ' ');
    formattedKey = formattedKey.replace(/\bvpp\b/gi, 'VPP');
    formattedKey = formattedKey.replace(/\bapn\b/gi, 'APN');
    return formattedKey;
};