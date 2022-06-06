const {AutotaskRestApi} = require('@apigrate/autotask-restapi');
const ITGlue = require('node-itglue');
const fetch = require("node-fetch-commonjs");
const dns = require('dns');

module.exports = async function (context, req) {
    const params = new URLSearchParams(req.body);
    context.log('JavaScript HTTP trigger function processed a request.');

    const testType = (params && params.get('testType'));
    const organizationName = (params && params.get('organizationName'));
    const resourceName = (params && params.get('resourceName'));
    const resourceTimeToExpiry = (params && params.get('resourceTimeToExpiry'));
    const resourceUrl = (params && params.get('resourceUrl'));

    context.log(`Test Type: ${testType}, Org: ${organizationName}, Resource: ${resourceName}, Time To Expiry: ${resourceTimeToExpiry}, URL: ${resourceUrl}`);

    const responseMessage = resourceName
        ? "Test: '" + testType + "' on '" + resourceName + "' was triggered. Org: " + organizationName +
            " \n Time to Expiry: " + resourceTimeToExpiry +
            " \n Url: " + resourceUrl
        : "This HTTP triggered function executed successfully.";

    if (testType != "Domain Expiry" && testType != "SSL Expiry") {
        context.log.warn("Test Type '" + testType + "' is not supported. Exiting...");
        context.log.error("testType: " + testType + ", orgName: " + organizationName + ", resourceName: " + resourceName + ", timeToExpiry: " + resourceTimeToExpiry + ", resourceUrl: " + resourceUrl);
        context.res = {
            status: 400,
            body: "Test Type '" + testType + "' is not supported. Exiting..."
        };
        context.done();
        return;
    }


    // Connect to the Autotask API
    const autotask = new AutotaskRestApi(
        process.env.AUTOTASK_USER,
        process.env.AUTOTASK_SECRET, 
        process.env.AUTOTASK_INTEGRATION_CODE 
    );
    let api = await autotask.api();

    // Connect to the ITG API
    const itg = new ITGlue({
        apikey: process.env.ITG_API_KEY,
        timeout: 10000,
        mode: 'apikey'
    });

    // Get org info from ITG
    let itgCompany;
    await itg.get({path: "organizations", params: {
        "filter[name]": organizationName
    }})
    .then(result => {
        if (result.data && result.data[0]) {
            itgCompany = result.data[0];
        }
    })
    .catch(error => {
        context.log.error(error);
    });

    // Find company in Autotask
    let autotaskCompanies = await api.Companies.query({
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

    if ((!autotaskCompanies || autotaskCompanies.items.length < 1) && itgCompany && itgCompany["short-name"]) {
        autotaskCompanies = await api.Companies.query({
            filter: [
                {
                    "op": "or",
                    "items": [
                        {
                            "op": "eq",
                            "field": "CompanyNumber",
                            "value": itgCompany["short-name"]
                        },
                        {
                            "op": "eq",
                            "field": "Client Abbreviation",
                            "value": itgCompany["short-name"],
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
    if (autotaskCompanies && autotaskCompanies.length == 1) {
        let locations = await api.CompanyLocations.query({
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

        let contract = await api.Contracts.query({
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
        await itg.get({path: "organizations/" + itgCompany.id + "/relationships/domains", params: {
            "page[size]": 1000
        }})
        .then(result => {
            if (result && result.data) {
                itgDomainInfo = result.data.find(d => d.attributes.name == resourceName);
            }
        })
        .catch(error => {
            context.log.error(error);
        });

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
            detailedNotes += `Expires On: ${expiresOn.toLocaleDateString('en-ca', { weekday:"long", year:"numeric", month:"short", day:"numeric"})} \n`;
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
        await itg.get({path: "organizations/" + itgCompany.id + "/relationships/expirations", params: {
            "filter[resource_type_name]": "SslCertificate",
            "page[size]": 1000
        }})
        .then(result => {
            if (result && result.data) {
                itgSSLInfo = result.data.find(d => d.attributes['resource-name'] == resourceName);
            }
        })
        .catch(error => {
            context.log.error(error);
        });

        var ipAddress = null;
        if (!resourceName.startsWith("*")) {
            // Get more info on the cert if it is connected to a domain
            try {
                ipAddress = await ipLookupFromDomain(resourceName);
            } catch(err) {
                console.log.warn(`${resourceName} is not a valid domain. IP lookup failed.`);
            }
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
            detailedNotes += `Expires On: ${expiresOn.toLocaleDateString('en-ca', { weekday:"long", year:"numeric", month:"short", day:"numeric"})} \n`;
            detailedNotes += `ITG Url: ${resourceUrl}`;
        }

        var title = `SSL Cert Expiring: ${resourceName}`;
        var description = `Alert from IT Glue.\n`;
        if (autotaskCompanies[0].id == 0) {
            description += `Organization: ${organizationName}\n`;
        }
        description += `The ssl cert '${resourceName}' is expiring in ${resourceTimeToExpiry}. \n\n\n${detailedNotes}`;
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
        Description: description,
        DueDateTime: expiresOn.toISOString()
    };

    var ticketID = null;
    try {
        result = await api.Tickets.create(newTicket);
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
            context.log.warn("Ticket creation failed. Backup email sent to support.");
        } catch (error) {
            context.log.error("Ticket creation failed. Sending an email as a backup also failed.");
            context.log.error(error);
        }
        ticketID = null;
    }

    context.res = {
        // status: 200, /* Defaults to 200 */
        body: responseMessage
    };
}

async function ipLookupFromDomain(domain) {
    return new Promise((resolve, reject) => {
        dns.lookup(domain, (err, address, family) => {
            if (err) reject(err);
            resolve(address);
        });
    });
};