# This module is used for local testing and experimentation


from sqlalchemy import CHAR, create_engine, Column, Integer
from sqlalchemy.orm import declarative_base, sessionmaker
from pydantic_settings import BaseSettings, SettingsConfigDict


# finding environment variable for database connection
class Settings(BaseSettings):
    data_url: str
    model_config = SettingsConfigDict(env_file=".env")


DB_URL = Settings().data_url

# connection to database, ie "engine"
engine = create_engine(DB_URL)

# define a base class for our models
Base = declarative_base()


class PlaygroundTable(Base):
    __tablename__ = "PlaygroundTable"

    ID = Column(Integer, primary_key=True)
    Name = Column(CHAR(2))
    Variable = Column(CHAR(2))

# Base.metadata.create_all(engine)

def check_connection():
    try:
        with engine.connect():
            print("Connection to the database was successful!")
    except Exception as e:
        print(f"An error occurred while connecting to the database: {e}")


check_connection()


# create a session factory
Session = sessionmaker(bind=engine)
session = Session()

# read write operations


def add_entry(name, variable, id):
    new_entry = PlaygroundTable(Name=name, Variable=variable, ID=id)
    session.add(new_entry)
    session.commit()


def read_entries():
    entries = session.query(PlaygroundTable).order_by(PlaygroundTable.ID).all()
    for entry in entries:
        print(f"ID: {entry.ID}, Name: {entry.Name}, Variable: {entry.Variable}")


def read_entry(id):
    entry = session.query(PlaygroundTable).filter_by(ID=id).first()
    if entry:
        print(f" Found entry \n ID: {entry.ID}, Name: {entry.Name}, Variable: {entry.Variable}")
        return entry
    else:
        print(f"No entry found with ID: {id}")


def update_entry(id, new_name, new_variable):
    entry = read_entry(id)
    if entry:
        entry.Name = new_name
        entry.Variable = new_variable
        session.commit()
        print(f"Entry with ID: {id} has been updated.")
        print(f"ID: {entry.ID}, Name: {entry.Name}, Variable: {entry.Variable}")
    else:
        print(f"No entry found with ID: {id}")


# Example usage
# add_entry("d", "4", 40)
# read_entries()
# read_entry(20)
# update_entry(20, "b", "2")
